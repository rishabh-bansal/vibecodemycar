# Live testing (the live kit)

The live kit drives the car from a Mac terminal in real time, through the same engine the web app uses. The engineer
sees every adapter byte and every coding decision as it happens. Use it to test a change on the car without the
browser, phone or Web Bluetooth in the way.

```
OBDBLE adapter ──BLE──> tools/live/bin/elm-bridge ──TCP 127.0.0.1:35000──> npm run live -- <command>
   (in the car)          (raw byte pipe, Swift)                               (scripts/live.ts: the app's engine)
```

- **The bridge** (`tools/live/elm-bridge.swift`) is a raw byte pipe. It does no ELM logic and filters nothing. It
  keeps the adapter connected between commands and serves one client at a time, so two commands can never
  interleave on the car's bus.
- **The CLI** (`scripts/live.ts`) runs the app's own code: `WebBluetoothLink` over a TCP transport, the
  `CodingController` and `runSession` with the deps the app's session store builds, recipes from
  `src/data/app-data.json`, and feature resolution from `src/domain/catalog/features.ts`. Writes go through the same
  writer (`ble-writer.ts` / `dataset-writer.ts`), backup, read-back and journal as in the browser.

## Owner: preparing the car (once per session)

1. **Plug the adapter** (the OBDBLE clone) into the OBD port under the dashboard.
2. **Ignition on, engine off.** Dashboard lit, engine not running, car parked. Keep it that way for the whole
   session. If the car goes to sleep the modules stop answering. Cycling the ignition wakes them again.
3. **Mac on charge, Bluetooth on, within a few metres of the car.**
4. **First run only: allow Bluetooth for Terminal.** The first time the bridge starts, macOS asks
   "Terminal would like to use Bluetooth". Click **Allow**. If you missed it, go to System Settings → Privacy &
   Security → Bluetooth and turn on Terminal (or iTerm, or whichever app runs the command), then start the bridge
   again.
5. Start the bridge and leave it running in its own terminal window:

   ```bash
   npm run live:bridge            # builds tools/live/bin/elm-bridge, scans for "obd", connects, listens on :35000
   ```

   It prints one JSON line per event. Wait for `"event":"ready"`. `rssi` lines show signal strength. A
   `ble-disconnected` line followed by `reconnecting` means the adapter dropped and the bridge is reconnecting on
   its own. A name filter can be passed when the adapter is not called "OBD…": `tools/live/bin/elm-bridge vlink`.

When you are done, press Ctrl-C in the bridge window, switch the ignition off and unplug the adapter.

## Engineer: commands

Run these in a second terminal. Every command is one connection: it starts with `ATZ`, does its work and
disconnects. The bridge keeps the adapter connected between commands.

### Read-only first, always

Nothing in this group can change the car. Start every session with these, in this order:

```bash
npm run live -- status                      # bridge reachable? adapter answers ATI / ATRV (voltage)
npm run live -- identify                    # adapter profile, BCM + cluster identity, VIN present (hash only)
npm run live -- features                    # the car on the bus → catalogue: what the app offers for it
npm run live -- read 09 0A5E                # one 22 read: unit (09, 17, bcm, cluster, …) or req:resp, DID
npm run live -- inspect 09                  # the app's module inventory scan of one unit
npm run live -- scan                        # full car scan: every unit found and read, mapped to a file
npm run live -- scan --units 09,17          # the same, only these units (add --deep for the range sweep)
npm run live -- raw ATRV 0100               # raw commands, through the app's send policy
```

- **`features`** tells the car from its own modules. A BCM or cluster part number that has a live proof in the
  catalogue sets the model, variant and build. Pass `--model` to override, or when the car cannot be told from its
  parts: `--model kushaq`, `--model skoda/kushaq/monte-carlo`, plus `--year 2024` if needed. With `--model`,
  `features` does not touch the bus at all.
- **`raw`** refuses write and routine services (`2E`, `31`, `27`, …) unless you pass `--unsafe`. Do not use
  `--unsafe` on the car; `apply` and `restore` are the way to write.
- **`inspect`** walks the unit's identifier list (CarScanner manifest) and records which identifiers answer, are
  refused or stay silent. It also reports what each recipe on that unit currently reads. It takes a few minutes
  per unit. `inspect all` is the full car scan below.
- **`scan`** is the full car scan, the same run as the app's "inspect all". It sends only `22` reads: the scan's
  link refuses anything else, and the adapter's send policy is locked to reads for the whole run.
  1. **Discovery.** It reads F187 once (twice if there is no answer) on every known unit address: the inventory
     table, every recipe's unit, the vendor corpus pairs and a few +0x6A convention addresses. A unit that does
     not answer is marked not fitted.
  2. **Reads.** On each fitted unit it reads the identity (F187 F189 F191 F197 F19E F1A2 F1A3 F1AA F17C F18C
     F190), 0600, every identifier a recipe uses, the BCM lamp records 0550..0583, and the unit's backup manifest.
     Identifiers that stay silent are read once more at the end.
  3. **Map.** It builds the car map: each unit with its identity and every value, each catalogue feature's
     current state on this car, the decoded lamp records, and the answering identifiers no recipe explains.
     The map is saved as `<log-dir>/scans/<started>-<VIN>.json` and `.md`, a summary is printed (units, values,
     features on and off), and the experiment record that holds the map is uploaded like any session.
  - `--units 09,17` limits discovery and reads to those units. `--deep` also sweeps 0400..0BFF, 5000..50FF and
    6000..60FF on 09 and 17, skipping identifiers already read. A range stops after 16 unanswered reads in a row
    or after 10 minutes.
  - **Duration on the Kushaq:** about 20 to 30 minutes. Discovery takes about 5 minutes, because each unfitted
    address costs about 13 s of failed protocol searches. The reads take about 0.8 s each. `--deep` adds up to an
    hour. The run stops at 45 minutes (110 with `--deep`) or after 10 minutes on any one unit, and keeps
    everything read so far. A dropped adapter is reconnected (up to 3 times per unit) and the scan resumes
    at the identifier it was on.

### Evidence: health, log, mark, compare, report (read-only)

The evidence kit for a service visit: a timestamped record of every fault and abnormal reading, and a way to tell
afterwards whether a fault was repaired or only cleared. The ordered plan for the car is docs/CAR_SESSION_PLAN.md.

```bash
npm run live -- health --label baseline --odometer 27000   # one evidence snapshot (engine off, then at idle)
npm run live -- log --scenario D --fast --minutes 5         # live data to CSV; Enter writes a MARK row
npm run live -- mark clatter at 2000 rpm                    # from another shell: a mark the running log picks up
npm run live -- compare <before.json> <after.json>          # gone / new / still, clear evidence, software changes
npm run live -- report <health.json> [log.csv ...]          # the advisor's page (.md and standalone .html)
```

**Read-only, enforced in code.** `health` and `log` lock the adapter's send policy to the health reads for the
whole run (`SafetyPolicy.enterHealthReadOnly`): OBD-II 01, 02, 03, 05, 06, 07, 08 (only the `0800` list), 09, 0A;
UDS `19` sub-functions 01, 02, 03, 04, 06, 0A; `22` reads of one identifier; `3E`; `10 01` / `10 03`. Every UDS
request is also checked by `assertHealthRequest` (`src/domain/health/readonly.ts`) before it is handed over. 04,
14, 2E, 2F, 31, 27, 11, 10 02, 28 and 85 are refused before they reach the adapter, and no clear token or coding
permit is issued or honoured while the lock holds. The snapshot records the policy's refusals (none expected).

- **`health [--label baseline|after|<text>] [--odometer <km>] [--units 01,09,17]`** runs two connections:
  1. the app's OBD-II connection (`0100` search) and its full scan: VIN, CALID, CVN, ECU name, MIL and code count,
     readiness monitors, PIDs 21 / 30 / 31 / 4D / 4E / A6, stored / pending / permanent codes with the freeze frame,
     mode 06 with limits (misfire per cylinder A2…, catalyst, oxygen sensors highlighted). A part no ECU answered
     (identity, a code list, mode 06) is read again up to twice before it counts as not supported;
  2. the native coding connection, one unit at a time: identity (F187 F189 F191 F1A3 F18C F197), `19 01 FF` count,
     `19 02 FF` list with every status bit decoded, and per DTC `19 04 <DTC> FF` snapshot and `19 06 <DTC> FF`
     extended data. Raw hex is kept; VW fields (snapshot mileage 2002, extended records 01 priority, 02 frequency
     counter, 03 unlearning counter) are decoded and marked "unverified". A list longer than the clone forwards is
     reported as `truncated: got N of M bytes` and asked again split by status mask (08, 04, 01).

  The units are `--units`, else the units of the newest saved car map (`live scan`) plus 01 and 02, else every
  known address (units that do not answer are listed as not reachable). Engine OBD codes (modes 03 / 07 / 0A) get
  their meaning from the built-in generic SAE table only; anything else reads "meaning: unknown
  (manufacturer-specific)". A control unit's UDS DTC is **not** an SAE code: VW numbers them internally (the 3 DTC
  bytes as one number) and only VW's label files name them. They are shown as `VW <decimal> (0x<hex6>) <status
  class>`, e.g. `VW 17142 (0x0042F6) failed since the last clear`, with no meaning attached; the JSON keeps the raw
  bytes, and older snapshots (which stored an SAE reading such as "P0042") render the new way. The brakes (713) and
  airbags (715) answer `7F 19 78` first: the read keeps the adapter listening with `3E 80` for up to 10 s. On the
  owner's clone the airbags never delivered the list (2026-11-09): the report then says "fault memory not read
  (check the warning lamp)". The odometer is PID A6
  when the ECU has it, else `--odometer`, else "not recorded". Output: `<log-dir>/health-<label>-<iso>.json` and
  `.md`; a summary goes into the uploaded connection log.
- **`log --scenario <A-F|name> [--fast] [--pids 0C,0D,...] [--minutes N]`** polls at the highest rate the link
  manages (the app's live loop and throughput tuner) and writes one CSV row per sample: ms since start, time, and
  every PID decoded with its unit (a blank cell = not read in that sample). Only PIDs the ECU reports supported are
  logged; the header lists the rest. Scenarios A-F are the plan's (`src/domain/health/livelog.ts`, `SCENARIOS`);
  D and E use the `--fast` set. A MARK row is written by Enter in the logging terminal (a typed note goes with it)
  or by `live mark [note]` from another shell (appended to `<log-dir>/marks.txt`, which the logger follows). The mode
  06 misfire counters are read at the start and the end. It stops on Ctrl-C or after `--minutes` and prints the
  summary: full-throttle events (pedal to full boost as a bracket from the neighbouring samples — each PID is read on
  its own, about every 0.5-1.4 s — boost, rpm rise, lowest timing overall and with the pedal held and no shift, a
  persistent timing retard if any, lowest rail pressure), the log's full-load timing by rpm band, low-rpm timing
  retard under load, fuel trims beyond ±10 % for over 30 s, the cold-start warm-up curve, the conditions at each
  mark. Output: `<log-dir>/log-<scenario>-<iso>.csv`.
- **Report heuristics (from the first car session).** Timing at or below 0 degrees at full throttle is flagged only
  when the pedal stays above the full-throttle level, no upshift (an rpm fall of over 300 rpm) is within 1.5 s, the
  low reading lasts 2 timing samples in a row, and it is 4 degrees or more below the same log's median full-load
  timing within ±500 rpm; otherwise it is listed under "Looks normal" as a shift / pedal-lift torque cut or the base
  map, with the numbers. "Slow boost" is flagged only when the bracket's lower bound is over 3 s. Timing at or below
  -10 degrees under 1300 rpm with load 30 % or more, or MAP 80 kPa or more (coolant 40 °C or warmer), is flagged as
  a clatter clue with its timestamps (knock or a planned torque reserve: generic OBD cannot tell). Each kind is one
  finding with every event's numbers, merged across the report's logs.
- **`vwread` / `vwlog`** (UDS `22` reads only, locked like `health`): the engine's VW measuring values. On the
  owner's Kushaq (Bosch MED17.1.27, 04C906025EH SW 2838) 38 values read with ignition on, engine off, among them
  13F4 knock-control ignition angle (one cylinder) and 11DD / 11DC manifold pressure specified / actual — the
  commanded boost that PID 70 does not return on this ECU (70 and 6D give actual values only). `vwlog` logs them to
  CSV like `log`, for the knock-control check at low rpm under load.
- **`compare`** and **`report`** read files only (no bridge). The thresholds behind "suspicious" are in
  `THRESHOLDS` (`src/domain/health/livelog.ts`): heuristics, not manufacturer limits.

### Writing: apply and restore

```bash
npm run live -- apply <featureId> <settingId>          # e.g. apply comfort-lane-change-indicator-5-flashes value-5
npm run live -- apply <featureId> value:<n>            # free value for a scalar feature
npm run live -- backups                                # the local backups (ids for restore)
npm run live -- restore <backupId>                     # put a backup's original back
```

Before anything is written, `apply` and `restore`:

1. identify the car (the VIN is read and never shown; only its length and a 12-character hash are printed);
2. read what they need to plan, all harmless reads: the coded DID, plus the variant probes for recipes with
   several versions and each part of a multi-part (group) feature;
3. print the **exact plan**, one `[plan]` line per block: module (`70E:778`), DID, `before` → `after` bytes, the
   `owned` mask (the bits the recipe may change) and the changed bytes;
4. ask `Write … to the car? [y/N]`. Anything but `y` writes nothing (exit 2). `--yes` skips the question. Without a
   terminal (piped or scripted) and without `--yes`, nothing is written.

The run then is the app's session: verify the car and module, readiness (a warning, never a gate), a backup saved
to disk **before** the write, the writer, the read-back, the outcome. The link is fenced to the confirmed plan. If
the run asks to write any module, DID or bytes that were not on the plan (say the car's value changed between
the preview and the write), that write is answered `not-sent` without reaching the wire, and the error is printed.

Ctrl-C during a run asks for cancel. It is honoured only until the data write is on the wire; after that the run
always finishes and records its honest outcome.

Exit codes: `0` verified or observed-match (read back exactly), `1` any other outcome or an error, `2` not
confirmed or refused by the send policy, `64` usage error.

### Frame test: the 8th byte of a full CAN frame

The owner's OBDBLE clone ("ELM327 v2.1") corrupts the **8th byte of every full 8-byte frame** sent raw (`ATCAF0`):
the module stores `0x30` or `0xA0` there, bytes 1 to 7 arrive intact, and `ATAL` changes nothing. It also fills the
8th byte of a 7-byte frame. **Conclusion of the 2026-11-09 car session: there is no software workaround on this
adapter**; a write whose change sits on a frame's 8th byte needs a genuine ELM327 or an STN adapter. When such a write
is answered 78 and the read-back shows the old bytes, the writer reports what the module holds (`pending-no-final`
with `stored`) and does not re-send: a re-send would deliver the same stray again.

**F198 is write-only on the owner's BCM** (`22 F198` → `7F 22 31`, also F199), so on that car `frametest` stops before
writing anything: "F198 is not readable on this module: frame test not possible; use `repair` on a known stray
DID". The rest of this section applies to a module whose F198 reads. `frametest`
measures which way of handing frames to the adapter gets that byte through. It writes **only the BCM's (70E/778)
F198 workshop code**, through the real writer (gateway hop, extended session, security access with the unit's
default code 31347, coding markers off), and puts the original back at the end.

```bash
npm run live -- status                                   # bridge and adapter up
npm run live -- read 09 F198                             # what F198 holds now (6 bytes)
npm run live -- frametest --yes                          # all modes: full, trim-zero, fc-alt (+ stpx on an STN adapter)
npm run live -- frametest --yes --modes full,trim-zero   # only these modes
npm run live -- echo                                     # reads only: does the adapter receive 8-byte frames intact?
npm run live -- repair                                   # owner's BCM: stray bytes back to factory (trim-zero, with markers;
                                                         # the BCM refuses coding without the F198 login: 7F 2E 24; --no-markers skips them)
npm run live -- read 09 F198                             # check the restore
```

`--yes` is required: without it nothing is written (exit 2). Each run writes F198 twice per mode, then once more to
restore it: at most 9 writes.

The frame modes (`packages/obd-core/src/elm/uds.ts`, `FrameMode`):

| mode | what goes to the adapter |
| --- | --- |
| `full` | every frame as its 16 hex digits (the default, the proven native framing) |
| `trim-zero` | a full frame whose 8th byte is `00` goes as its first 7 bytes and the adapter pads it (`ATPP26SV00` + `ATPP26ON` at setup, `ATPP26OFF` after; a `?` to them is tolerated). The workaround of Trionic's ELM327 driver and pyren/ddt4all. Frames ending in another byte still go whole. |
| `fc-alt` | the adapter's flow-control data is `31 00 05` instead of `30 04 05` (`ATFCSD310005`). A diagnostic: if the stored 8th byte becomes `0x31`, the clone fills it from the flow-control buffer. |
| `stpx` | STN adapters only (`STI` answers `STN…`): the whole request in one `STPX h:<hdr>,d:<hex>,r:1` with `ATCAF1` + `STCSEGT1`, so the chip builds the frames itself. Skipped on any other adapter. |

`2E F1 98` plus 6 bytes is 9 bytes, so every write is a first frame plus one consecutive frame:
`10 09 2E F1 98 d0 d1 d2` / `21 d3 d4 d5 …`. F198 data byte 2 (`d2`) is the 8th frame byte under test. Each trial
writes the original with `d2` set to `00` and then to `5A`, and `d1` set to a value unique to that trial (the 7th
byte arrives intact, so it proves the write landed). It then reads F198 back.

**Reading the result.** The table on stdout has one row per trial and one for the restore:

```
mode               8th  sent          write  stored        8th stored  result
full               00   014100F63039  acked  014130F63039  30          CORRUPTED
trim-zero          00   014700F63039  acked  014700F63039  00          OK
...
restore (trim-zero) 00  018100F63039  acked  018100F63039  00          RESTORED
```

- `OK`: everything stored as sent. `CORRUPTED`: the trial landed (its 7th byte is there) but the 8th byte is
  wrong; `8th stored` shows what the module holds. `NOT LANDED`: the write did not reach the module (see `write`).
- The `[result]`/`[warn]` lines below the table say it in words: what each mode did, whether `fc-alt` moved the
  byte to `0x31` (the flow-control buffer hypothesis), and `use: 8th byte 0x00 → <mode>; other 8th bytes →
  <mode>`. `no mode stored a non-zero 8th byte` means this adapter cannot send such a frame whole: only an STN
  adapter (`stpx`) or a genuine ELM327 can.
- The restore uses the best mode for the original's own 8th byte. If no mode stores that byte right, F198 is
  written with `full` and the report says `F198 NOT restored` with what it holds. F198 is only the workshop code
  of the last coding: nothing in the car depends on it.
- Exit code `0` when F198 was restored exactly, `1` otherwise.

The report is saved as it grows (the original F198 is on disk before the first write) to
`~/.obdcraft/live/frametest-<iso>.json`: the adapter's identity, the original, every trial with the frames as
intended (`data`) and, where different, what the adapter was given (`sent`), the best modes, the restore and the
findings. The same summary goes into the uploaded connection log (`frame-test-trial`, `frame-test-result`).

**Using a mode afterwards.** `--frame-mode full|trim-zero|fc-alt|stpx` on any write command (`apply`,
`restore`, …) makes every write of that command use it, for example
`npm run live -- apply <featureId> <settingId> --frame-mode trim-zero`. Remember that `trim-zero` only helps a frame
whose 8th byte is `00`. Every connection also records the adapter's identity (`ATI`, `AT@1`, `STI`/`STDI`, `ATPPS`
on non-STN adapters) as an `[adapter]` line and in the connection log.

**Rehearsing.** `npm run live:fake -- --sim --calm --byte8` adds the clone's fault to the simulator (the 8th byte
of a full frame arrives as the first flow-control byte): `full` fails, `trim-zero` stores `00`, `fc-alt` stores
`31`. `npm run live:fake -- --stn` makes the emulator an STN chip, so `stpx` runs too. Then run
`npm run live -- frametest --yes` against it as with the car.

### What streams to the terminal

Each line is stamped with `+ms` since the start of the command and `Δms` since the previous line.

| tag | what |
|---|---|
| `TX` / `RX` / `ST` | every command to the adapter, every reply chunk, late bytes |
| `[plan]` | a block the command is about to write (before → after, owned mask) |
| `[note]` | a writer decision: session open, seed/key, marker, payload send, 78 pending, proof read, resend … |
| `[variant-selected]` | which version of a multi-version recipe the module's answers chose, and why |
| `[readiness]` | engine speed, road speed, voltage measured just before the backup |
| `[backup]` | the backup id, saved to disk before the write |
| `[outcome]` | `verified`, `observed-match`, `mismatch`, `pending-uncertain`, `rejected`, `not-sent` or `cancelled` |
| `[upload]` | what went to the private cloud log |

`npm run live -- tail` follows the newest session log from another terminal. `tail <file>` follows a given one.

### VINs

The VIN is never printed or written to the terminal log. Every RX line answering a `22 F190` read is replaced by
`[redacted N chars]`, any 17-character VIN-like text is masked, and the car is shown only as a hash. The app's own
records (backups, experiments, connection logs) keep the full VIN by design, as in the browser, so the cloud log
can file each session under its car.

## Where logs go

| what | where |
|---|---|
| terminal log, one per command | `~/.obdcraft/live/<ISO time>.ndjson` (every TX/RX line and event, VINs redacted) |
| backups, experiment records, connection logs | `~/.obdcraft/live/db/obdcraft-live.json` (the app's database, saved after every change) |
| full car scans (car map and report, named by the full VIN) | `~/.obdcraft/live/scans/<started>-<VIN>.json` and `.md` |
| health snapshots, comparisons, advisor reports | `~/.obdcraft/live/health-<label>-<iso>.json`/`.md`, `compare-…`, `report-…md`/`.html` |
| live data logs and marks | `~/.obdcraft/live/log-<scenario>-<iso>.csv`, `~/.obdcraft/live/marks.txt` |
| the paired car (fingerprint only) | `~/.obdcraft/live/pairing.json` |
| cloud upload credential (never printed) | `~/.obdcraft/live/cloud-storage.json` (mode 600) |
| private cloud log | the log Worker, under the car's VIN: `npm run logs:pull`, then `npm run logs:summary -- <file>` |

`--log-dir <dir>` moves all of it. Backups are only in the local store: keep `~/.obdcraft/live/db/` until every
change made from the kit has been restored or is no longer needed.

**Uploads.** After `features`, `inspect`, `scan`, `apply` and `restore`, the CLI queues every local record that changed
(experiment, operation journal and connection-log items) through the app's outbox and uploads it, exactly as the
browser does. The engineer pulls them with `npm run logs:pull`. On the first upload, the machine registers as an
upload-only collector.

- `--upload` / `--no-upload`. Uploading is the default, so `--upload` only states it. `--no-upload` keeps the
  records local: they stay queued and go up with the next command that uploads. When both are given,
  `--no-upload` wins. The first `[session]` line of every command shows the choice (`upload: on` or `off`, or
  `not to the real log (fake bridge)`), and the last `[upload]` line says what was uploaded or kept.
- Nothing is uploaded when the connection to the bridge fails. The connection log starts only once the bridge and
  adapter are up, so a failed connect leaves no record behind for this command or a later one to upload.
- Runs against the fake bridge are never uploaded to the real log. While the fake bridge serves a port, it leaves a
  marker file naming that port, and the CLI treats every run on that port as synthetic, whatever the identity reads
  return. Sessions with the kit's synthetic VINs or fake part numbers (the simulator too) are treated the same way.
  Their records get a permanent "not for upload" mark, so a rehearsal can share the store with real sessions.
- `OBDCRAFT_LOG_ENDPOINT=http://localhost:8787` (as for `logs:pull`) sends the uploads to another log Worker, such
  as `wrangler dev`. That endpoint has its own credential file, and uploads to it include synthetic sessions. An
  override that names the real log Worker does not: synthetic sessions still stay out of it.

## Rehearsing without the car

```bash
npm run live:fake                               # ELM327 emulator + fake BCM (70E) and cluster (714)
npm run live:fake -- --sim                      # the clone simulator: the live clone's drops and quirks, Kushaq modules
npm run live:fake -- --sim --calm               # the same modules on a perfect adapter
npm run live:fake -- --sim --seed 7             # another random sequence
npm run live:fake -- --sim --calm --byte8       # plus the owner's clone's 8th-byte fault (for frametest)
npm run live:fake -- --stn                      # the emulator as an STN chip (STI, STPX)
npm run live:fake -- --sim --rx-fc-loss 1       # every answer over 4 consecutive frames truncated (health split)
npm run live:fake -- --port 35123               # any fake on another port, when the real bridge holds 35000
```

For `health`, both fakes carry synthetic faults (`src/infra/link/testing/health-car.ts`): engine codes P0301
(stored, permanent, freeze frame) and P0299 (pending), PID 21/30/31 counters, a failed cylinder-1 misfire monitor;
two UDS DTCs on the BCM and a nine-DTC list on the cluster, each with snapshot and extended data.

Then run the same commands as with the car. Everything in the fake modules is synthetic.

- **Emulator** (`live:fake`): a well-behaved adapter. Its part numbers are fake, so pass `--model kushaq`. It hosts
  BCM `0A5E` and cluster `0E46` for `apply`. Type `sleep` / `wake` in its window to switch the bus off and on, and
  `writes` to count module writes.
- **Simulator** (`--sim`): `src/infra/link/testing/clone-sim.ts` in real time. The adapter drops requests as the
  live clone does, re-searches and answers 78 to writes; the modules keep S3 timeouts, seed/key and markers. The
  modules hold the demo fixtures of every codable Kushaq feature, with the real proof part numbers, so `features`
  identifies the car without `--model`. `writes` shows which DIDs the modules stored and how many requests were
  dropped.

## Troubleshooting

- **`ECONNREFUSED … is the bridge running?`** Start `npm run live:bridge` (or `live:fake`) first.
- **The bridge never prints `ready`.** Check that the adapter is plugged in and the ignition is on, then check the
  Bluetooth permission (step 4 above). Only one app can hold the adapter: close the web app and phone apps.
- **`refused: The car didn't tell us its VIN`.** The bus is asleep. Cycle the ignition (on, engine off) and run
  `identify` again.
- **A second client is refused.** Another `live` command is still running: wait for it or Ctrl-C it.
- **`pending-uncertain` or `mismatch`.** Nothing is retried automatically. Run `read <unit> <did>` to see what the
  module holds, then decide. The backup is in `backups`.
