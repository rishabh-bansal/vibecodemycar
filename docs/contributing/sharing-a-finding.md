# Sharing a finding

A finding is anything you learned on a real car that the next person would want to know:

- "Lane change blinks worked on my 2024 Slavia Style — BCM 2Q0937089F."
- "Needle sweep is refused on the digital cluster 2GJ920700A (NRC 31)."
- "My vLinker MC+ writes fine; my cheap ELM327 clone reads but every write fails."
- "Coming-home lights: the Taigun's setting lives in the BCM, not the cluster."
- "Unit 15 (airbag) never answers through this adapter."

You don't need to write code.

## The quick way: an issue

[Open a "Car finding" issue](https://github.com/rishabh-bansal/vibecodemycar/issues/new?template=car-finding.yml). The form asks for the car, the
adapter, what you tried, and what happened.

## The thorough way: a car page

Every car has a page in [`cars/`](../../cars/) — what's known about it, module by module, with the evidence.
Copy [`cars/_template.md`](../../cars/_template.md) to `cars/<brand>-<model>.md` if your car has none, or add to
the existing page, and open a PR.

## What makes a finding useful

- **The car:** brand, model, model year, trim, engine and gearbox, instrument cluster (analogue / digital).
- **Part numbers** of the control units involved (`F187`), and software versions if you have them (`F189`).
  Part numbers are not personal; they are what lets the app pick the right recipe.
- **The adapter** you used (make, model, BLE or Classic).
- **What you did and what happened,** with the bytes when you have them: before, written, read back. Error codes
  (NRC) as numbers (`7F 2E 22`).
- **How sure you are:** tested and read back / seen once / heard from someone.

## Never include

Your **VIN**, registration number, or the **serial numbers** of control units or adapters. Mask them: `MEX…1234`.
