# Škoda Kushaq

| | |
|---|---|
| Platform | MQB-A0-IN (India 2.0) — shares its electrics with Slavia, Kylaq, Taigun, Virtus |
| Model years seen | 2022 |
| Engines / gearboxes | 1.0 TSI with Aisin AQ250 6-speed automatic |
| Instrument cluster | analogue and digital variants |

Everything below was measured on one owner's car over a Bluetooth adapter, read-only unless it says otherwise.

## Control units

| Unit | Address (request → response) | Part numbers seen | Notes |
|---|---|---|---|
| 09 Body computer | 70E → 778 | 2Q0937089D | Coding writes need the workshop login first: write `F198` and `F199`, then the coding. Without them the write is refused with NRC `24`. `F198` / `F199` are write-only (reading them gives NRC `31`). |
| 17 Instrument cluster | 714 → 77E | 2GJ920700A | |
| 01 Engine | 7E0 → 7E8 | 04C906025EH (Bosch MED17.1.27) | Answers VW measuring values over `22`: 139 DIDs found in `1000`–`13FF`, e.g. `13F4` knock-control angle, `11DC` / `11DD` intake pressure actual / specified. |
| 02 Gearbox | 7E1 → 7E9 | 09S927158DM (Aisin AQ250) | |
| 03 Brakes | | | Fault memory read works, but it answers "response pending" (NRC `78`) first: keep the session alive with `3E 80` while waiting. |
| 15 Airbag | | | Never answered through a clone adapter. |

## Fault codes

- Read stored faults with `19 02 2D` (status mask `2D`). Mask `FF` returns many entries that are not real faults.
- VW control units report faults as their own 24-bit numbers. They are **not** SAE `P0xxx` codes, and decoding them
  as SAE gives wrong names. The app shows them as `VW <decimal> (0x<hex>)`.

## Features

| Feature | Result | Evidence |
|---|---|---|
| Lane change blinks | Recipe in the app (BCM `0A5E`) | not yet confirmed with a genuine adapter |

Coding results with a genuine adapter (OBDLink CX / MX+, vLinker MC+) are very welcome — please add them here.

## Adapters

| Adapter | Reads | Writes | Notes |
|---|---|---|---|
| "OBDBLE v2.1" (cheap BLE ELM327 clone) | ✅ | ❌ | Corrupts the **8th byte of every CAN frame it sends** — single, first and consecutive frames, and it fills a short frame's 8th byte too. What it receives from the app arrives intact (echo test), so it is the adapter. No software workaround worked (trimmed frames, alternative flow control, markers). Fine for reading; use a genuine adapter for writing. |

## Quirks and notes

- With the gearbox in D at a standstill, ignition timing reads −12° to −19°. That is normal idle-in-gear
  behaviour, not knock.
- Torque cuts during gear changes show up as short timing drops in logs. They are not faults.
