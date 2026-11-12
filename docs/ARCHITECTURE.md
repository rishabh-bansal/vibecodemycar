# Architecture

## Shape

```
screens → state/session-store → domain/coding/controller → run.ts: runSession(request, deps)
                                                              │ target → verify → backup → write → read back
           CarLink (port) ◄───────────────────────────────────┘
           └─ WebBluetoothLink (infra/link/web-bluetooth.ts)
                ├─ ble-writer.ts       single-DID writes (field, scalar, ops, alt; each part of a group)
                ├─ dataset-writer.ts   declared command sequences (dataset, or any recipe with a `sequence`)
                └─ @obdcraft/coding probe.ts (reads) → @obdcraft/obd-core (ElmSession, ISO-TP, UDS, SafetyPolicy)
           BackupStore (port) ── Dexie / IndexedDB ── infra/cloud outbox ──► workers/logs (Worker and D1)
```

**Only `domain/coding/run.ts` decides what happened.** Links are I/O: they report what was sent and what came
back, and never declare success. The UI shows the reducer's result (`progress.ts`), which comes from the
read-back. `infra/link/simulator.ts` and `demo.ts` are test doubles. They are not wired into the app.

Routes: `/` · `/car` · `/features` (catalogue, with `?f=` for a feature's detail) · `/connect` · `/coding` ·
`/done`. `/backups` redirects to `/features`.

## Policy: writes are on, nothing gates

`src/config/policy.ts` holds only the readiness band (11.0–15.2 V) used to word warnings, and the adapter
shop link. A `WebBluetoothLink` has `canWrite = true` whenever the adapter exposes a write characteristic. No
environment variable switches writes. The only `live-writes-disabled` refusal is for a link that is
physically read-only.

**Warnings** (journaled and shown; they never stop a write): readiness (rpm, speed, voltage) outside the band
or unreadable, an unreadable or unrecorded part number, and a car other than the paired one on an apply.

**Refusals** (nothing is sent):
- there is no VIN, so a backup could not be bound to the car;
- the module is silent;
- no variant matches the control unit (`variant-unsettled`);
- the value is already set;
- the backup could not be saved durably;
- the request names a recipe that is not the catalogue's;
- the link is quarantined.

A restore also refuses on another car (`wrong-car`), another part number, a changed recipe definition
(`target-changed`), a pre-digest backup (`needs-requalification`), or bytes changed since the operation
(`restore-conflict`).

## The session (`runCoding`, `runGroup`)

1. **Target.** The recipe comes from the bundled `app-data.json` and never from the request. A restore must
   resolve to the same module, DID and recipe digest (`recipeDigest`, or a `legacyDigests` entry) it was made
   with.
2. **Verify.** Reads the VIN (`F190`) and part number (`F187`), and the hardware number (`F191`) when a variant
   needs it. Stores a SHA-256 fingerprint, a mask and the full VIN.
3. **Variant.** For an `alt` recipe, `variant-select.ts` decides from harmless reads (below).
4. **Backup.** Reads the original block, plans the change (`plan.ts`, bit encoder in
   `@obdcraft/coding/blocks`) and saves the operation record **durably before any write**.
5. **Write.** Sends one write through the link and records:
   - the markers, the security exchange and the writer's decisions;
   - the transmitted frames (`txFrames`);
   - the readiness measured at the time.

   The domain never retransmits. Its backstop waits for the link's declared worst case (`maxWriteMs` or
   `maxSequenceMs`).
6. **Read back** (up to 3 reads). Every bit the trusted recipe owns (`ownedMask`) must hold the intended
   value:
   - `verified`: there was an ACK;
   - `observed-match`: no final ACK was captured;
   - `mismatch`: a different value, or a change outside the recipe that is not a recorded module-managed
     byte (`known-readbacks.ts`);
   - `pending-uncertain`: no read-back came;
   - `rejected`: the ECU returned an NRC.

**Ambiguous writes retire the link.** If a deadline expires, the link is lost or the link throws mid-write,
the link is closed and quarantined, and every later session on it refuses. A dropped link is re-established
and the session rerun (at most 2 times) only when the event stream proves nothing that could change the car
was sent.

**Groups** (`kind: 'group'`): every part is planned first. Planning a part means identifying its module,
settling its variant and reading its original. One record journals all parts, and the parts are written in
order, each on its own module, and each read back. A part whose control-unit version does not match is skipped
(written back unchanged). "Off" restores single-choice parts from the newest backup of that part. A restore
walks the landed parts in reverse.

**Other flows.**
- *Check again* (`runRecheck`) is read-only. It re-reads every written part and compares it to the intended
  value.
- *Inspect* (`runInspect`, `/connect?inspect=<unit|all>`) is a read-only scan of a unit's DID inventory. It
  is bounded in time, stops on a silence streak, resumes after a relink, and retries silent DIDs once.

## Recipe kinds (`domain/catalog/types.ts`, validated by `schema.ts`)

| Kind | Write |
|---|---|
| `field` | one bit field; each choice is a wire integer, optional per-choice `aux` bit writes |
| `scalar` | a physical value → raw (`multiplier`/`offset`/`dataLength`, bounds); presets or a free `value:<n>` on the step grid; optional `crc32-trailer` |
| `ops` | explicit `BitOp[]` per choice; `when` limits a choice to an MIB generation and/or bit values as read |
| `alt` | ordered variants, each its own encoding, DID and optional password; one is selected on the car |
| `group` | steps (each any non-group kind, on its own unit and CAN ids) under shared choice ids |
| `dataset` | a complete block per choice, written with the recipe's declared `sequence` (pre/post commands, optional download) |

Passwords are from the recipe, or the unit's default code (`passwordSource: 'unit-default'`). A refused
unit-default code is named as such in the result.

## Variant selection (`domain/coding/variant-select.ts`)

The rule is **ordered first match**, as in the vendor tool. Each variant's precondition comes from its
selector:
- **unit 09 / new-bcm / old-bcm**: the BCM is new-generation when `0600` reads as at least `len - 1` zero bytes
  or is not hosted;
- **MIB2.5 / MIB3**: decided from `F19E` (`EV_MUOIMQB` / `EV_MUCNSMQB` mean MIB3). When the generation is
  unknown, a variant is used only when exactly one generation-unique DID (MIB3 `0556`) answered;
- **`devicePattern`**: `*pattern*` is matched against `F187` or `F191`, with non-alphanumerics stripped
  (CheckDevice);
- **otherwise**: the variant's DID answered with data.

`variantProbePlan` lists the reads, which are all harmless. Only a genuine no-match refuses. The decision
(`variant-selected` or `variant-refused`) and the answer lengths are journaled.

## Writer discipline (`infra/link/ble-writer.ts`)

The order follows the native writer (`reference/native/ble-write-coding.swift`):

```
gateway 10 03 (710, reply ignored) → module 10 03 → 22 F199 / 22 F1A5 probes → 10 03 re-arm
→ 27 03 seed / 27 04 key → 2E F199 <BCD date> → 2E F198 <F1A5 bytes or fallback> → 2E <did> <bytes>
→ proof read 22 <did> → 10 01
```

The rules come from live failure analysis of the OBDBLE clone:
- **Re-bind before every request.** Each request goes out on a fresh `ATSH/ATCRA/ATFCSH/ATSP0` re-search
  (`SETTLE_MS = 0`), because the clone silently drops requests after idle time or after other AT commands.
  When an idempotent step goes silent, it is re-sent on a new re-search, up to 4 times.
- **Nothing is heard after the prompt.** A `78` or a `NO DATA` is reported at once. The DID's own memory is
  read (a proof read) instead of listening while S3 lapses.
- **Session freshness.** S3 is about 5 s. A session counts as proven for 4 s after `50 03`, `67 04` or a
  positive answer. A step that cannot reach the module inside that window re-arms first (`10 03`, plus the
  security exchange). The number of re-arms per write is bounded, and 2 are always kept for the payload.
- **Security.**
  - The key is the seed plus the password (32-bit).
  - A zero seed means the unit is already unlocked.
  - The same seed after an *acknowledged* key means the grant still holds, so the key is not re-sent.
  - The same seed after an *unacknowledged* key means that key never arrived, so the key is sent.
  - A silent key is followed by a new seed, not by a new session.
- **Markers are cosmetic.**
  - F199 is written whenever its probe got any answer.
  - F198 is written from F1A5, or from the vendor fallback when F1A5 is all zero.
  - A refused or silent marker is recorded and never blocks the payload.
  - Each marker is reported as `no-answer`, `acked`, `refused` or `not-hosted`.
- **Payload.**
  - The payload is never re-sent after an ACK.
  - It is re-sent only when the first frame got no flow control (the write never left the adapter), or when
    a proof read shows the pre-write bytes (not stored).
  - NRC `7F`, `33` or `22` (and `31` when the session may have lapsed) is retried once after a re-arm before
    it is believed.
- **End.** `10 01` returns the unit to the default session (best effort). `MAX_WRITE_MS` is derived from
  every bound above.
- **Permits.** Every `2E`/`27` is covered by one `obd-core` permit that lives as long as the write can. Its
  security budget is derived from the same bounds.

`dataset-writer.ts` runs declared sequences with the same discipline. It runs each listed step: sessions,
`2704` security, the markers, read-and-restore of identity, reset, DTC clear and routines. Its phase contract
(prepare, then mutating, then payload, then post) says what a failure means at each point. A payload that was
acknowledged is never erased or repeated.

Every writer decision is emitted as a compact `writer` event: DIDs and NRC codes only, never payload bytes,
seeds or keys.

## Backups (`domain/backups/schema.ts`, `infra/storage`)

The schema is `vibecode-my-car.backup/2`; records and files written as `obdcraft.backup/2` (the app's old
name, same format) load as it. A v1 record is migrated, with `ack` and `linkMode` set to `unknown`.

Each record keeps:
- the VIN (mask, fingerprint, full) and the module (CAN ids, part);
- the DID, `before`, `intended` and `observed` bytes, the `ownedMask` and any `moduleManaged` bytes;
- the `recipeDigest` and the variant index;
- the markers, readiness, `txFrames`, `outcome` and `ack`;
- an append-only `history`.

A group record keeps every part's entry. A restore is its own operation (`operation: 'restore'`, `restoreOf`)
saved before its write. The source record only gains an appended entry. Records are never overwritten.

Backups are per car. Restore is offered on a feature's detail page for the newest restorable apply (`verified`,
`unconfirmed` or `prepared`, with a digest, not demo) whose VIN fingerprint matches the car this browser is set
up for. Dexie is at version 6 (tables `backups`, `experiments`, `outbox`, `connectionLogs`).
`navigator.storage.persist()` is requested.

## Cloud logging (`infra/cloud`, `workers/logs`)

Each browser registers with the log Worker as an upload-only collector. It uploads:
- every operation record and experiment (events, writer decisions, readiness, variant choice);
- every connection's full command log, in chunks of 1500 entries, about 900 KB, or 60 s.

Each item carries the full VIN and the build (`buildId`, `gitSha`, version), and the Worker files it under
the VIN. Only the ECU serial number (`F18C`) and the adapter serial number (`AT@2`, `STSN`) are blanked
(`domain/logs/redact.ts`).

Sync runs at start, on visibility change, every 30 s, on connect, at the end of a run and on link close. On
`pagehide` the open chunk is sent with a keepalive request when it is small enough. Retries are:
- unbounded with backoff for network errors, 5xx and 429;
- on the next UTC day after the daily budget is spent;
- after 24 h, or on a new build, for a refused item.

The outbox never imports the link or the session (this is tested). Setting the localStorage key
`vibecode-my-car.cloud.optout = 1` stops uploads from that browser.

Worker routes:
- `/v1/register`, `/v1/enroll`, `PUT /v1/items/<kind>/<key>` (upload), `/v1/status`;
- owner-only: `/v1/cars`, `/v1/items?vin=`, `/v1/export`.

Retention is 180 days, enforced by a daily cron. The CSP (`public/_headers`) allows `connect-src` only to the
site itself and the Worker.
