# Deploy (Cloudflare only)

Hosting: **Cloudflare Pages**, project `vibecodemycar` → https://vibecodemycar.pages.dev (`npm run deploy` also
publishes the same build to the older `obdcraft` project, so https://obdcraft.pages.dev keeps working). Static SPA; security headers in
`public/_headers`, SPA fallback in `public/_redirects`. Backups, journals and experiment records live on-device
(IndexedDB). The only server-side data is the private diagnostic log (below): a Cloudflare Worker with a D1
database that every browser uploads its logs to, unless the person opts out. Each log is filed under the car's
full VIN.

```bash
npx wrangler login                 # once
npm run deploy                     # check (incl. public-boundary check) + build + publish to production
npx wrangler pages deployment list --project-name vibecodemycar
```

`wrangler` is pinned to 4.88.0: newer releases delegate `pages` commands to Cloudflare Workers autoconfig and fail in an
npm workspace root. Bump it only after checking `wrangler pages deploy` still works.

First-time project creation: `npx wrangler pages project create vibecodemycar --production-branch main`.

Build defaults: **car photos on** (owner's own; `VITE_CAR_IMAGES=0` drops them), **no research content**
(`VITE_RESEARCH_CATALOGUE` unset). **Live writes are on in every build**: there is no switch (owner directive
2026-11-01, `src/config/policy.ts`); a link that can write, writes, after the backup and with a read-back.
`VITE_LIVE_WRITES` is no longer read. Never set `VITE_RESEARCH_CATALOGUE=1` on a public build (see
`.env.example`); the boundary check in `npm run check` fails a build that carries research text or
research-only assets. Flags may come from the shell or `.env*` files —
the app and the build read the same values.

Deploy only from a clean `npm run check` on the committed tree: `wrangler pages deploy dist` publishes
whatever is in `dist/`, so never run it by hand on an older or research build.

## Diagnostic logs

Every browser registers itself with the log Worker (`workers/logs`, `obdcraft-logs` on workers.dev, D1
`obdcraft-logs`) as an upload-only collector and uploads each experiment (events and adapter trace), each
operation journal and each connection's full command log. Every item carries the car's full VIN (`vin`, from the
backup's `vin.full` or the VIN read in the trace; the reply to `22 F190` / `09 02` stays in the trace as received),
and the Worker files it under that VIN (`items.vin`). Only serial numbers are blanked before upload: the control
unit's (`22 F18C`) and the adapter's (`AT@2`, `STSN`); see `src/domain/logs/redact.ts`. Items carry `buildId` and
`body.build` (`gitSha` — `-dirty` when built from uncommitted changes — and the package version). Experiment
events include the writer's decisions (`writer`: session, security, markers, payload, proof reads, re-sends), the
measured `readiness` and the `variant-selected` / `variant-refused` choice. Retention: 180 days. Tests never
upload (no endpoint under vitest; `fetch` refuses anything but localhost).

Per car (owner devices only): `GET /v1/cars` lists every VIN with its item counts per kind and first/last seen;
`GET /v1/items?vin=<VIN>` and `GET /v1/export?vin=<VIN>` (paged or whole) narrow to one car. When a connection
reads the VIN after its first chunk was uploaded, the Worker files that connection's earlier chunks under the
car too. Items stored before migration `0004_items_vin.sql` have no VIN (`unfiled` in `/v1/cars`).

Uploads are automatic and keep trying. When they happen:
- At app start, on `visibilitychange`, every 30 s, on connect, at the end of a run, on link close, and each time a connection-log chunk closes. Chunks close at 1500 entries, about 900 KB, or 60 s.
- On `pagehide`, the open connection log is ended and sent with `keepalive` when it is small enough.

What happens when an upload fails:
- Offline, 5xx and 429 errors retry with up to 1 h of backoff and never give up.
- A used-up daily budget waits for the next UTC day.
- An item the Worker refused is retried after 24 h, with each new build, and on every app start.
- A revoked token makes the browser register again and take over its earlier items.
- A record that cannot be turned into an item uploads as a minimal `prepare-failed` item that says so; the record stays on the device.

Each browser also reports its outbox health to `/v1/status`. `logs:pull` saves those reports as `deviceStatus`, and `logs:summary` prints them.

A Worker change (`workers/logs/src/**`, `src/domain/logs/contract.ts`, new migrations) is **not** deployed by the Pages deploy. Run `npm run logs:deploy` for it; that command applies D1 migrations first.

**Order for the per-car release (migration `0004_items_vin.sql`): Worker first, then the site.**

1. `npm run logs:deploy` — applies `0004` (`items.vin` + index) to the remote D1, then deploys the Worker. Check
   with `npx wrangler d1 migrations list obdcraft-logs --remote --config workers/logs/wrangler.jsonc` (nothing
   pending).
2. `npm run logs:verify` — the synthetic checks include "filed under its VIN", the car list and the `?vin=`
   filters.
3. `npm run deploy` — the site. Its items carry `vin` and VIN replies; an older Worker would refuse them as
   "looks like a raw VIN", and they would wait in each browser's outbox until the Worker is updated, so never
   deploy the site first.

Existing records re-upload once with the new build (their content changed), now with their VIN where the record
knows it.

`scripts/capture-native.mjs … --upload` also uploads a native capture as `session` items.

```bash
npm run logs:deploy                # Worker + D1 migrations
npm run logs:pull                  # owner export → ~/.obdcraft/exports/export-<time>.json (outside the repo)
npm run logs:pull -- --vin <VIN>   # one car's logs only
npm run logs:pull -- --cars        # list the cars: VIN, items per kind, first and last seen
npm run logs:summary -- ~/.obdcraft/exports/export-<time>.json --since 2026-11-01T16:28 [--kind experiment] \
  [--recipe <id>] [--vin <VIN>] [--uds]   # per item: car, build, recipe, outcome, events; --uds adds UDS lines
npm run logs:summary -- ~/.obdcraft/exports/export-<time>.json --cars    # per car, from an export
```

`logs:pull` enrolls a temporary owner device with the code in `~/.obdcraft/cloud-enrollment-code`, downloads the
export page by page (`--since <ISO>`, `--no-demo`, `--vin <VIN>`), saves the car list as `cars`, and revokes the
device when done; it never prints the code or the token. `logs:summary` prints VINs in full and flags items that
look like test pollution (no wire trace and the simulator's VIN) as `[TEST?]`.
