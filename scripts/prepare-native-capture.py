#!/usr/bin/env python3
"""Build an isolated, observable, read-only copy of the native writer. Never connects to Bluetooth.

The source package must pass its existing provenance validator. All original files stay untouched.
Every injection has an exact-match assertion. Existing provenance/identity/transport guards stay intact.
The capture copy refuses writes; its redacted observation record cannot serve as a write qualification.
"""
import argparse
import hashlib
import json
import plistlib
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FILES = (
    "elm-transport.swift", "adapter-capability.swift", "ble-write-coding.swift",
    "ble-reader.swift", "ble-uds.swift", "ble-probe.swift", "build-provenance.swift",
    "build-clis.sh", "verify-provenance.py",
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def instrument(text):
    def replace(old, new):
        nonlocal text
        if text.count(old) != 1:
            raise ValueError(f"Native source changed: expected one injection site: {old[:90]}")
        text = text.replace(old, new)

    replace('let args = CommandLine.arguments', '''let args = CommandLine.arguments
        if args.contains("--capture-self-test") {
            BuildProvenance.requireSelf("ble-write")
            NativeCapture.selfTest()
            exit(0)
        }
        // This observation build cannot perform a coding operation, even if invoked without its wrapper.
        let captureFlags: Set<String> = ["--qualify", "--module", "--name", "--qual-out", "--help"]
        guard args.contains("--help") || (args.contains("--qualify")
            && args.dropFirst().filter { $0.hasPrefix("--") }.allSatisfy { captureFlags.contains($0) })
        else { print("Capture build permits read-only observation only"); exit(64) }''')
    replace('transport.receive(String(decoding: d, as: UTF8.self))',
            '''NativeCapture.event("notification", ["bytes": d.count])
        NativeCapture.wire("rx", String(decoding: d, as: UTF8.self))
        transport.receive(String(decoding: d, as: UTF8.self))''')
    replace('let bytes = Array((s + "\\r").utf8)',
            'NativeCapture.wire("tx", s + "\\r")\n        let bytes = Array((s + "\\r").utf8)')
    replace('p.writeValue(Data(chunk), for: w, type: type)',
            '''NativeCapture.submitted(chunk.count, type == .withoutResponse ? "without-response" : "with-response", false)
            p.writeValue(Data(chunk), for: w, type: type)''')
    replace('p.writeValue(blePending.removeFirst(), for: w, type: .withoutResponse)',
            '''NativeCapture.submitted(blePending[0].count, "without-response", true)
            p.writeValue(blePending.removeFirst(), for: w, type: .withoutResponse)''')
    replace('else { blePending.append(Data(chunk)) }',
            '''else {
                    NativeCapture.event("write-queued", ["bytes": chunk.count, "depth": blePending.count + 1])
                    blePending.append(Data(chunk))
                }''')
    replace('if mtu > 20 { bleChunkSize = min(mtu, 244) }',
            '''if mtu > 20 { bleChunkSize = min(mtu, 244) }
        NativeCapture.event("profile", ["service": nt.service?.uuid.uuidString ?? "",
            "write": writeChar?.uuid.uuidString ?? "", "notify": nt.uuid.uuidString,
            "maxWrite": bleChunkSize, "maximumWithoutResponse": mtu,
            "withoutResponse": writeChar?.properties.contains(.writeWithoutResponse) ?? false])''')
    replace('target = best.0; best.0.delegate = self; central.connect(best.0, options: nil)',
            '''NativeCapture.event("connect-start", ["rssi": best.2])
        target = best.0; best.0.delegate = self; central.connect(best.0, options: nil)''')
    replace('print("Link up."); peripheralId =', 'NativeCapture.event("connected"); print("Link up."); peripheralId =')
    for signature, label in (
        ('func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {', 'notifications-state'),
        ('func peripheral(_ p: CBPeripheral, didWriteValueFor c: CBCharacteristic, error: Error?) {', 'write-callback'),
        ('func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {', 'disconnected'),
    ):
        replace(signature, signature + f'\n        NativeCapture.event("{label}", ["error": error != nil])')
    # Only the final observation file changes. Its deliberately different schema is rejected by the original
    # qualification parser, and raw VIN/peripheral identifiers never reach disk. No gate is relaxed.
    replace('"schema": "carpulse.qualification/1",',
            '"schema": "obdcraft.read-observation/1", "writeAuthority": false,')
    replace('"peripheral": ["identifier": self.peripheralId],',
            '"peripheral": ["ref": NativeCapture.ref(self.peripheralId)],')
    replace('"vehicle": ["vin": self.identityEvidence["F190"] ?? "", "evidence": "F190"],',
            '"vehicle": ["ref": NativeCapture.ref(self.identityEvidence["F190"] ?? ""), "evidence": "F190"],')
    return text


def prepare(source_root, output):
    source_root, output = source_root.resolve(), output.resolve()
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Output must be a new directory inside an existing parent; no capture is overwritten")
    source = source_root / "scripts"
    subprocess.run(["python3", str(source / "verify-provenance.py"),
                    str(source_root), str(source / "bin")], check=True)
    original = (source / "ble-write-coding.swift").read_text()
    observed = instrument(original)  # validate every injection BEFORE creating a destination
    target = output / "scripts"
    target.mkdir(parents=True, mode=0o700)
    output.chmod(0o700)
    for name in FILES:
        shutil.copy2(source / name, target / name)
    (target / "ble-write-coding.swift").write_text(observed)
    with (target / "build-provenance.swift").open("a") as f:
        f.write("\n" + (REPO / "reference/native/capture-observer.swift").read_text())
    # Run the package's existing builder/validator, including all in-binary self-checks.
    subprocess.run(["bash", str(target / "build-clis.sh")], cwd=target, check=True)
    subprocess.run(["python3", str(target / "verify-provenance.py"),
                    str(output), str(target / "bin")], check=True)
    macos = output / "NativeCapture.app/Contents/MacOS"
    macos.mkdir(parents=True)
    for name in ("ble-write", "ble-reader", "ble-uds", "ble-probe", "build-manifest.json"):
        shutil.copy2(target / "bin" / name, macos / name)
    with (macos.parent / "Info.plist").open("wb") as f:
        plistlib.dump({
            "CFBundleIdentifier": "dev.obdcraft.nativecapture",
            "CFBundleName": "OBDCraft Native Capture",
            "CFBundleExecutable": "ble-write",
            "CFBundlePackageType": "APPL",
            "NSBluetoothAlwaysUsageDescription": "Record an owner-started, read-only diagnostic comparison.",
        }, f)
    manifest = {
        "schema": "obdcraft.capture-build/1",
        "sourceRoot": str(source_root),
        "baselineSources": {name: digest(source / name) for name in FILES},
        "baselineBuildManifestSha256": digest(source / "bin/build-manifest.json"),
        "observerSha256": digest(REPO / "reference/native/capture-observer.swift"),
        "instrumentedBuildManifestSha256": digest(target / "bin/build-manifest.json"),
        "limits": [
            "Host timestamps and GATT calls, not CAN bus timestamps or Bluetooth radio retransmissions.",
            "Additional logging can change timing; previousLoggingUs measures the previous record's logging cost.",
            "The existing read qualification sequence is observed, not a coding sequence.",
            "Final observation is redacted and cannot authorize a write.",
        ],
    }
    (output / "capture-build.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Prepared without opening Bluetooth: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    prepare(options.source_root, options.output)
