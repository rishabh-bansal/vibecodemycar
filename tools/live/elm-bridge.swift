// BLE ELM327 -> localhost TCP bridge for the live kit (scripts/live.ts).
//
//   tools/live/bin/elm-bridge [name-filter] [--name obd] [--host 127.0.0.1] [--port 35000]
//                             [--scan-seconds 4] [--rssi-seconds 5]
//
// A dumb byte pipe: whatever the TCP client sends goes to the adapter's write
// characteristic unmodified, and every notification goes back to the client
// unmodified. No command filtering, no framing, no ELM logic — the host side
// (ElmSession over TcpTransport) owns all of that, exactly as it does over Web
// Bluetooth. The BLE link stays up across TCP client reconnects, so each CLI
// invocation reuses the same connected adapter.
//
// Service layouts, characteristic choice and write chunking follow
// reference/native/ble-reader.swift and ble-write-coding.swift (the code that
// works with the owner's OBDBLE clone): known layouts first, then any
// notify+write pair; withoutResponse when the characteristic offers it, with a
// bounded FIFO honouring canSendWriteWithoutResponse; chunked to the negotiated
// write length (20 bytes floor, 244 ceiling).
//
// One TCP client at a time: a second client is refused (closed at once) rather
// than allowed to interleave commands with the first on the car's bus.
//
// The client is closed whenever the adapter may have lost or half-received its
// bytes (a BLE drop, bytes sent while not ready, a full send queue, a rejected
// write): the host then sees `closed`, as the browser does when GATT drops,
// instead of timeouts it would read as a silent module — and a power-cycled
// adapter back at its defaults never gets the old session's raw frames.
//
// stdout: one JSON object per line, {ts, event, ...}. Events: scanning, found,
// connecting, connected, services, ready, client-connected, client-closed,
// client-refused, ble-disconnected, reconnecting, rssi, dropped, error.
import CoreBluetooth
import Foundation
import Network

func argVal(_ args: [String], _ flag: String) -> String? {
    args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
}
let argv = Array(CommandLine.arguments.dropFirst())
let flagsWithValue: Set<String> = ["--name", "--host", "--port", "--scan-seconds", "--rssi-seconds"]
var positional: [String] = []
do {
    var i = 0
    while i < argv.count {
        if flagsWithValue.contains(argv[i]) { i += 2; continue }
        if argv[i] == "-h" || argv[i] == "--help" {
            print("usage: elm-bridge [name-filter] [--name obd] [--host 127.0.0.1] [--port 35000] [--scan-seconds 4] [--rssi-seconds 5]")
            exit(0)
        }
        positional.append(argv[i]); i += 1
    }
}
let nameFilter = (argVal(argv, "--name") ?? positional.first ?? "obd").lowercased()
let listenHost = argVal(argv, "--host") ?? "127.0.0.1"
let listenPort = UInt16(argVal(argv, "--port") ?? "35000") ?? 35000
let scanSeconds = Double(argVal(argv, "--scan-seconds") ?? "4") ?? 4
let rssiSeconds = Double(argVal(argv, "--rssi-seconds") ?? "5") ?? 5

func short(_ s: String) -> CBUUID { CBUUID(string: s) }
let layouts: [(String, CBUUID, [CBUUID], [CBUUID])] = [
    ("FFF0 (OBDBLE / Vgate / vLinker)", short("FFF0"), [short("FFF2"), short("FFF1")], [short("FFF1"), short("FFF2")]),
    ("FFE0 (HM-10)", short("FFE0"), [short("FFE1")], [short("FFE1")]),
    ("FFE5 / FFE9", short("FFE5"), [short("FFE9")], [short("FFE9")]),
    ("18F0 (vLinker / OBDLink)", short("18F0"), [short("2AF1")], [short("2AF0")]),
    ("ISSC transparent serial", short("49535343-FE7D-4AE5-8FA9-9FAFD205E455"), [short("49535343-8841-43F4-A8D4-ECBE34729BB3")], [short("49535343-1E4D-4BD9-BA61-23C647249616")]),
    ("BEEF", short("BEEF"), [short("BEEF")], [short("BEEF")]),
]

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

/// One status line on stdout. Never carries adapter payload bytes.
func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var obj = fields
    obj["ts"] = isoFormatter.string(from: Date())
    obj["event"] = event
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let s = String(data: data, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

final class Bridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var central: CBCentralManager!
    var target: CBPeripheral?
    var writeChar: CBCharacteristic?, notifyChar: CBCharacteristic?
    var chars: [(CBService, CBCharacteristic)] = []
    var servicesLeft = 0
    var candidates: [UUID: (CBPeripheral, String, Int)] = [:]
    var seen: Set<UUID> = []
    var scanning = false
    var scanRounds = 0
    var ready = false
    var shuttingDown = false

    // Bounded BLE send queue — CoreBluetooth drops withoutResponse submissions
    // made while canSendWriteWithoutResponse is false (R06 in the reference).
    var blePending: [Data] = []
    var bleChunkSize = 20
    var writeType: CBCharacteristicWriteType = .withResponse

    var listener: NWListener?
    var client: NWConnection?
    var clientSeq = 0
    var txBytes = 0, rxBytes = 0, droppedToClient = 0, droppedToBle = 0

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
        startListener()
    }

    // MARK: TCP side

    func startListener() {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.allowLocalEndpointReuse = true
        guard let port = NWEndpoint.Port(rawValue: listenPort) else { emit("error", ["message": "bad port"]); exit(2) }
        params.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(listenHost), port: port)
        do { listener = try NWListener(using: params) } catch {
            emit("error", ["message": "listen failed: \(error.localizedDescription)"]); exit(2)
        }
        listener?.stateUpdateHandler = { state in
            switch state {
            case .ready: emit("listening", ["host": listenHost, "port": Int(listenPort)])
            case .failed(let e): emit("error", ["message": "listener failed: \(e.localizedDescription)"]); exit(2)
            default: break
            }
        }
        listener?.newConnectionHandler = { [self] conn in accept(conn) }
        listener?.start(queue: .main)
    }

    func accept(_ conn: NWConnection) {
        if client != nil {
            // Two clients would interleave commands on the car's bus — refuse the newcomer.
            emit("client-refused", ["reason": "another client is connected"])
            conn.start(queue: .main)
            conn.cancel()
            return
        }
        clientSeq += 1
        let id = clientSeq
        client = conn
        conn.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                emit("client-connected", ["client": id, "bleReady": ready])
                receive(conn, id)
            case .failed(let e):
                closeClient(conn, id, "failed: \(e.localizedDescription)")
            case .cancelled:
                closeClient(conn, id, "cancelled")
            default: break
            }
        }
        conn.start(queue: .main)
    }

    /// Closes the current client, if any (see the header: the adapter can no longer be trusted with its session).
    func dropClient(_ reason: String) {
        guard let c = client else { return }
        client = nil
        c.cancel()
        emit("client-closed", ["client": clientSeq, "reason": reason, "txBytes": txBytes, "rxBytes": rxBytes])
    }

    func closeClient(_ conn: NWConnection, _ id: Int, _ reason: String) {
        guard client === conn else { return }
        client = nil
        conn.cancel()
        emit("client-closed", ["client": id, "reason": reason, "txBytes": txBytes, "rxBytes": rxBytes])
    }

    func receive(_ conn: NWConnection, _ id: Int) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [self] data, _, isComplete, error in
            if let data, !data.isEmpty { toBle(data) }
            if isComplete { closeClient(conn, id, "eof"); return }
            if let error { closeClient(conn, id, "error: \(error.localizedDescription)"); return }
            receive(conn, id)
        }
    }

    // MARK: byte pipe

    /// TCP -> adapter, unmodified. Bytes sent while the adapter is not ready are
    /// dropped (and counted), never queued: a stale command must not reach the
    /// car minutes later after a reconnect. The client is closed with them.
    func toBle(_ data: Data) {
        guard ready, let p = target, let w = writeChar else {
            droppedToBle += data.count
            emit("dropped", ["direction": "to-adapter", "bytes": data.count, "reason": "adapter not ready"])
            dropClient("adapter not ready")
            return
        }
        txBytes += data.count
        let bytes = [UInt8](data)
        var j = 0
        while j < bytes.count {
            let chunk = Data(bytes[j..<min(j + bleChunkSize, bytes.count)]); j += bleChunkSize
            if writeType == .withoutResponse && (!p.canSendWriteWithoutResponse || !blePending.isEmpty) {
                if blePending.count >= 256 {
                    // Never a command with a hole in it: the rest of this one is dropped and the client closed.
                    droppedToBle += bytes.count - (j - bleChunkSize)
                    emit("dropped", ["direction": "to-adapter", "bytes": bytes.count - (j - bleChunkSize), "reason": "BLE send queue full"])
                    blePending.removeAll()
                    dropClient("BLE send queue full")
                    return
                }
                blePending.append(chunk)
                continue
            }
            p.writeValue(chunk, for: w, type: writeType)
        }
    }

    /// Adapter -> TCP, unmodified. Without a client the bytes have nowhere to go.
    func toClient(_ data: Data) {
        rxBytes += data.count
        guard let c = client else { droppedToClient += data.count; return }
        c.send(content: data, completion: .contentProcessed { _ in })
    }

    // MARK: BLE side

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        emit("bluetooth", ["state": stateName(c.state)])
        if c.state == .poweredOn {
            if let p = target { reconnect(p) } else { startScan() }
        } else {
            ready = false
            dropClient("bluetooth \(stateName(c.state))")
        }
    }

    func stateName(_ s: CBManagerState) -> String {
        switch s {
        case .poweredOn: return "poweredOn"
        case .poweredOff: return "poweredOff"
        case .unauthorized: return "unauthorized"
        case .unsupported: return "unsupported"
        case .resetting: return "resetting"
        default: return "unknown"
        }
    }

    func startScan() {
        guard central.state == .poweredOn, !scanning else { return }
        scanning = true
        candidates = [:]
        scanRounds += 1
        // Re-scans run back to back until the adapter shows up; report the first and then every tenth.
        if scanRounds % 10 == 1 { emit("scanning", ["filter": nameFilter, "seconds": scanSeconds, "round": scanRounds]) }
        central.scanForPeripherals(withServices: nil, options: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + scanSeconds) { [self] in choose() }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        let name = p.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? ""
        if name.isEmpty { return }
        let match = name.lowercased().contains(nameFilter)
        if !seen.contains(p.identifier) {
            seen.insert(p.identifier)
            emit("found", ["name": name, "id": p.identifier.uuidString, "rssi": rssi.intValue, "match": match])
        }
        if match, rssi.intValue < 127 { candidates[p.identifier] = (p, name, rssi.intValue) }
    }

    /// Strongest matching advertiser wins (as ble-write-coding does); none -> scan again.
    func choose() {
        guard scanning else { return }
        guard let best = candidates.values.max(by: { $0.2 < $1.2 }) else {
            scanning = false
            central.stopScan()
            startScan()
            return
        }
        scanning = false
        central.stopScan()
        target = best.0
        best.0.delegate = self
        emit("connecting", ["name": best.1, "id": best.0.identifier.uuidString, "rssi": best.2])
        central.connect(best.0, options: nil)
    }

    func reconnect(_ p: CBPeripheral) {
        if shuttingDown { return }
        emit("reconnecting", ["id": p.identifier.uuidString])
        // A pending connect never times out in CoreBluetooth: it completes when the adapter is back in range/powered.
        central.connect(p, options: nil)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        emit("connected", ["name": p.name ?? "", "id": p.identifier.uuidString])
        blePending.removeAll()
        chars = []
        writeChar = nil; notifyChar = nil
        p.delegate = self
        p.discoverServices(nil)
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        emit("error", ["message": "connect failed: \(error?.localizedDescription ?? "?")"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [self] in reconnect(p) }
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        ready = false
        blePending.removeAll()
        writeChar = nil; notifyChar = nil
        emit("ble-disconnected", ["reason": error?.localizedDescription ?? "closed", "autoReconnect": !shuttingDown])
        // Bytes sent now would be dropped and the adapter may come back reset: the host must see the link close.
        dropClient("ble-disconnected")
        if !shuttingDown { reconnect(p) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices e: Error?) {
        let services = p.services ?? []
        servicesLeft = services.count
        if servicesLeft == 0 {
            emit("error", ["message": "no services — disconnecting to retry"])
            central.cancelPeripheralConnection(p)
            return
        }
        for s in services { p.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        for ch in s.characteristics ?? [] { chars.append((s, ch)) }
        servicesLeft -= 1
        if servicesLeft == 0 { pick(p) }
    }

    func props(_ c: CBCharacteristic) -> [String] {
        var out: [String] = []
        if c.properties.contains(.read) { out.append("read") }
        if c.properties.contains(.write) { out.append("write") }
        if c.properties.contains(.writeWithoutResponse) { out.append("writeWithoutResponse") }
        if c.properties.contains(.notify) { out.append("notify") }
        if c.properties.contains(.indicate) { out.append("indicate") }
        return out
    }

    func pick(_ p: CBPeripheral) {
        let w: (CBCharacteristic) -> Bool = { $0.properties.contains(.write) || $0.properties.contains(.writeWithoutResponse) }
        let n: (CBCharacteristic) -> Bool = { $0.properties.contains(.notify) || $0.properties.contains(.indicate) }
        var layoutName = "by-properties"
        for (name, svc, ws, ns) in layouts {
            let inside = chars.filter { $0.0.uuid == svc }.map { $0.1 }
            if let wr = ws.compactMap({ u in inside.first { $0.uuid == u && w($0) } }).first,
               let nt = ns.compactMap({ u in inside.first { $0.uuid == u && n($0) } }).first {
                layoutName = name; writeChar = wr; notifyChar = nt; break
            }
        }
        if writeChar == nil, let nt = chars.map({ $0.1 }).first(where: n), let wr = chars.map({ $0.1 }).first(where: w) {
            writeChar = wr; notifyChar = nt
        }
        let listing = chars.map { ["service": $0.0.uuid.uuidString, "char": $0.1.uuid.uuidString, "props": props($0.1)] as [String: Any] }
        guard let wr = writeChar, let nt = notifyChar else {
            emit("services", ["layout": "none", "characteristics": listing])
            emit("error", ["message": "no write+notify characteristic pair — disconnecting to retry"])
            central.cancelPeripheralConnection(p)
            return
        }
        writeType = wr.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
        let mtu = p.maximumWriteValueLength(for: writeType)
        bleChunkSize = mtu > 20 ? min(mtu, 244) : 20
        emit("services", [
            "layout": layoutName, "write": wr.uuid.uuidString, "notify": nt.uuid.uuidString,
            "writeType": writeType == .withoutResponse ? "withoutResponse" : "withResponse",
            "chunk": bleChunkSize, "characteristics": listing,
        ])
        p.setNotifyValue(true, for: nt)
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
        if let error {
            emit("error", ["message": "subscribe failed: \(error.localizedDescription) — disconnecting to retry"])
            central.cancelPeripheralConnection(p)
            return
        }
        guard c.uuid == notifyChar?.uuid else { return }
        ready = true
        emit("ready", ["chunk": bleChunkSize, "clientConnected": client != nil])
        scheduleRssi(p)
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        guard c.uuid == notifyChar?.uuid, let d = c.value, !d.isEmpty else { return }
        toClient(d)
    }

    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
        guard let w = writeChar else { blePending.removeAll(); return }
        while !blePending.isEmpty, p.canSendWriteWithoutResponse {
            p.writeValue(blePending.removeFirst(), for: w, type: .withoutResponse)
        }
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor c: CBCharacteristic, error: Error?) {
        // A rejected chunk may leave half a command on the adapter: the client is closed rather than let it go on.
        if let e = error {
            blePending.removeAll()
            emit("error", ["message": "BLE write rejected: \(e.localizedDescription)"])
            dropClient("BLE write rejected")
        }
    }

    var rssiGen = 0
    func scheduleRssi(_ p: CBPeripheral) {
        rssiGen += 1
        let gen = rssiGen
        func tick() {
            guard gen == rssiGen, ready, p.state == .connected else { return }
            p.readRSSI()
            DispatchQueue.main.asyncAfter(deadline: .now() + rssiSeconds) { tick() }
        }
        tick()
    }

    func peripheral(_ p: CBPeripheral, didReadRSSI rssi: NSNumber, error: Error?) {
        guard error == nil else { return }
        emit("rssi", [
            "rssi": rssi.intValue, "txBytes": txBytes, "rxBytes": rxBytes,
            "droppedToClient": droppedToClient, "droppedToAdapter": droppedToBle, "client": client != nil,
        ])
    }

    func shutdown() {
        shuttingDown = true
        client?.cancel()
        listener?.cancel()
        if let p = target { central.cancelPeripheralConnection(p) }
        emit("exit", ["txBytes": txBytes, "rxBytes": rxBytes])
        exit(0)
    }
}

setvbuf(stdout, nil, _IOLBF, 0)
let bridge = Bridge()
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigSources = [SIGINT, SIGTERM].map { sig -> DispatchSourceSignal in
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    s.setEventHandler { bridge.shutdown() }
    s.resume()
    return s
}
_ = sigSources
dispatchMain()
