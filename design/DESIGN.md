# Vibecode my car — NeoPOP design spec (for Claude Code)

This is the single source of truth for Vibecode my car's UI (the app was called OBDCraft until 2026-11;
the mock-ups in `screens/` and `feature-catalogue/screens/` still show the old wordmark). It replaces every earlier
design direction (the brutalist red/yellow/blue system and the minimal Inter/
JetBrains look are both retired). Build only this.

Stack in the repo: React + TypeScript, shadcn-style primitives, lucide-react.
The look is inspired by CRED's open-source NeoPOP (Apache-2.0,
github.com/CRED-CLUB/neopop-web). You may use `@cred/neopop-web` for its
ElevatedButton / raised-plunk behaviour, or reproduce it with the tokens below.
Do not copy CRED's brand name, logo or proprietary fonts.

Reference screens are in `screens/` — open them in a browser. They are static
mockups: copy their layout, spacing and copy, not their markup (all inline
styles, no components). `tokens.css` holds the tokens.

---

## 1. Product in one paragraph

Free, self-serve car coding for Indian-market Škoda & VW. The user picks their
car, browses unlockable features by section, picks ONE feature at a time,
connects a Bluetooth ELM327 OBD adapter (or buys one via Amazon), and the app
saves the original setting → makes the change → checks it with the car. Every
change can be undone. Backups and logs are kept automatically in the background
for each car; the app never shows a backups list, logs or upload status.

## 2. Flow & navigation

```
Landing (web) ──► 1 Your car ──► 2 Features ──► 3 Feature detail
                                    ▲                 │ "Apply to my car"
                                    │                 ▼
                          6 Done ◄─ 5 Save original & change ◄─ 4 Connect
```

- ONE feature per coding session. No multi-select anywhere.
- Bottom nav (mobile) / top nav (desktop): FEATURES · MY CAR.
- Production wording only: no build banner, no testing/experimental language,
  no engineering terms. There is no demo mode and no demo bar.
- Hide the nav on screens 4 and 5 (the user must not wander mid-write).
- Screen 5 has no Back button while a write is in progress.
- Back button = 44×44 dark tile, top-left, on screens 3 and 4.

## 3. Tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0d0d0d` | page ground |
| `--surface` | `#161616` | cards, inputs |
| `--surface-2` | `#111111` | desktop side panel |
| `--line` | `#2e2e2e` | 1px borders, dividers |
| `--line-faint` | `#222222` | disabled card border |
| `--ink` | `#ffffff` | primary text, "selected" fill |
| `--ink-2` | `#a3a3a3` | body copy |
| `--ink-3` | `#8a8a8a` | sub-copy |
| `--ink-4` | `#6b6b6b` | micro-labels, white-tile shadow |
| `--ink-off` | `#5e5e5e` | unavailable rows |
| `--yellow` | `#ffe24d` | primary CTA, accents, "unlocked" zone |
| `--yellow-edge` | `#8f7a12` | yellow plunk shadow |
| `--green` | `#06c167` | tested / verified / connected / success |
| `--green-edge` | `#04733d` | green plunk shadow |
| `--blue` | `#4d7cff` | Bluetooth tile only |
| `--blue-edge` | `#2a4396` | blue plunk shadow |

**Radius: 0 everywhere.** (Only the phone mockup frame on the canvas is rounded.)

**Plunk (the NeoPOP 3D edge):** hard offset shadow, no blur, bottom-right.
- small `3px 3px 0`, medium `4px 4px 0`, large `5px 5px 0`, hero `8–10px`.
- Shadow colour = the darker edge of the fill: white → `--ink-4`,
  yellow → `--yellow-edge`, green → `--green-edge`, dark card → `#262626`.
- Pressed state: translate(+offset) and drop the shadow (button sinks in).

**Type**
- Display: `DM Serif Display` 400, lowercase, line-height 1, ends with a full
  stop ("18 hidden features.", "speed chime is on."). Mobile 36–44px, desktop 44–104px.
- UI: `Manrope` 500/600/700/800.
- Micro-label: Manrope 800, 10–11px, letter-spacing 1.5–2px, UPPERCASE, `--ink-4`.
- Buttons: Manrope 800, 13–15px, letter-spacing 1.5px, UPPERCASE, arrow `→`.
- Body: Manrope 500, 14–15px, line-height 1.55, `--ink-2`.

**Spacing:** mobile side gutter 20px; cards gap 10–14px; touch targets ≥44px,
primary CTA 58–60px tall.

## 4. Components

| Component | Spec |
|---|---|
| `PrimaryButton` | yellow fill, black text, large plunk, full width on mobile. One per screen. |
| `SecondaryButton` | `--surface` + 1px `--line`, white text, no plunk. |
| `InvertButton` | white fill, black text, small plunk (Restore, Open app). |
| `ChoiceTile` | selected = white fill + black text + medium plunk; unselected = surface + line. Used for brand, cluster, setting radios. |
| `FilterChip` | same as ChoiceTile but compact (10×14 padding, 12px uppercase). Selected chip is yellow. |
| `FeatureRow` | surface card + line + `4px 4px 0 #262626`; 40px status tile left, name + status label, `→` right. Whole row is the link. |
| `StatusTile` (40px) | **available**: solid green, black ✓ · **unavailable**: 1px line, `–`, row in `--ink-off`, row not clickable. |
| `StatusBadge` | inline pill version: green fill "✓ AVAILABLE FOR YOUR CAR", micro-label type; unavailable = "NOT AVAILABLE FOR YOUR CAR" outline. |
| `StepCard` (coding) | done = surface + green ✓ tile; **active = white card + black text + medium plunk + hollow square spinner**; pending = faint border, grey text. |
| `StatGrid` | 3 columns, 1px `--line` gaps, micro-label over value (TIME / BACKUP / UNDO). |
| `WarningBar` | yellow fill, black 800 uppercase "⚠ DON'T UNPLUG OR CLOSE THE APP", yellow plunk. |
| `BottomNav` | white block, 4px plunk, two equal tabs; active tab = black inset tile with white text. |
| `CarHero` | surface card, car side-profile image bottom-aligned, model micro-label top-left, yellow serif feature count top-right. |
| `ColourSwatch` | 24px squares, selected has 2px white border; swaps CarHero image. |

## 5. Logo — "Gauge O"

The O of VIBECODE is a speedometer: 270° white arc (stroke 13 on a 100 box),
the top-right segment yellow (the "unlocked" zone), yellow needle pointing
into it, square yellow hub. Wordmark: `VIBEC` + dial + `DE`, then `MY CAR` in
`--yellow` 0.3em after it, all Manrope 800. In the wordmark the dial is framed
to its painted extent (`viewBox="3.5 3.5 93 79.5"`), its height equals the cap
height (0.72em), it sits on the baseline, with 1px margin each side.
`<Logo stacked>`: VIBECODE over MY CAR (wide letter-spacing), for a splash
screen and other large uses. `<Logo collapsible>`: below 360px wide the header
shows the dial alone.

```svg
<svg viewBox="0 0 100 100" aria-hidden="true">
  <path d="M21.7 78.3 A40 40 0 1 1 78.3 78.3" fill="none" stroke="#fff" stroke-width="13"/>
  <path d="M84.6 30 A40 40 0 0 1 78.3 78.3" fill="none" stroke="#ffe24d" stroke-width="13"/>
  <path d="M50 50 L77 31" stroke="#ffe24d" stroke-width="9"/>
  <rect x="43" y="43" width="14" height="14" fill="#ffe24d"/>
</svg>
```
Wrap the whole wordmark in an element with `aria-label="Vibecode my car"`.
Spelling: "Vibecode my car" in sentences, "VIBECODE MY CAR" in the wordmark and
micro-labels, `vibecode-my-car` / `vibecodeMyCar` for ids.
App icon: the dial alone in black on a yellow tile (with yellow-edge plunk), or
the full-colour dial on black. Make it a `<Logo size>` component.

## 6. Screens

**1 · Your car** — logo + FREE badge · H1 "which car are we unlocking?" ·
CarHero (updates live) · colour swatches · brand ChoiceTiles (Škoda / VW) ·
Model select · Variant + Year selects · Cluster ChoiceTiles (Analogue / Digital) ·
PrimaryButton "SEE FEATURES →". VIN is read on connect, not typed.

**2 · Features** — logo + car chip (tap → screen 1) · H1 "18 hidden features."
with small car image · FilterChips by section (All, Lights, Dashboard, Comfort,
Infotainment, Driver assist) · FeatureRow list, available first, then
unavailable · BottomNav.

**3 · Feature detail** — Back · StatusBadge · H1 feature name · one-line
description · setting ChoiceTiles (radio) · StatGrid · PrimaryButton
"APPLY TO MY CAR →" · SecondaryButton "RESTORE ORIGINAL SETTING" (with a
confirm dialog) only when this car has a saved original for this feature.

**4 · Connect** — Back + "STEP 1 / 2 · <FEATURE>" · blue Bluetooth tile ·
H1 "plug in. pair up." · 3-step grid · PrimaryButton "CONNECT VIA BLUETOOTH" ·
SecondaryButton "NO ADAPTER? BUY ON AMAZON ↗" (affiliate link — config value).

**4a · Pick your adapter** (bottom sheet after "CONNECT VIA BLUETOOTH", where the app scans itself: a native
build, or `?scanner=fake` in development; the web build uses the browser's own chooser, filtered to adapters) —
`--surface-2` sheet, 1px top border, 8px yellow top edge, drag handle, H2 "pick your adapter.", ✕ 40px dark
tile · blue micro status "SCANNING · N FOUND" / "N FOUND" · LAST USED pinned on top · "LOOKS LIKE AN OBD
ADAPTER" (yellow LIKELY badge; top match = white card, 5px plunk; others `--surface`; subline chip · BLE ·
signal; 3-bar meter) · "OTHER DEVICES" greyed (`--ink-off`) but tappable, with a hint · footer "Don't see
yours? Check the adapter's light." + "↻ RESCAN". States: connecting (in the card), "this doesn't answer like
an OBD adapter — try another one", Bluetooth off (OPEN SETTINGS where the platform allows it), permission
denied (why + TRY AGAIN), nothing found after 10 s (the 3 steps again). Code: `src/screens/connect/`.

**5 · Save original & change** — CONNECTED green badge + "STEP 2 / 2" · H1 "setting up your
<feature>." · StepCards: Car verified (screen shows the masked VIN `MEXK…1234`; backups,
journals and logs keep the full VIN) → Original saved →
Making the change (shows real elapsed seconds) → Checking it worked · WarningBar.
No fake progress bar: steps change only on real events.

**6 · Done** — green ✓ tile · H1 "<feature> is on." · "done and checked with
your car" · SecondaryButton "UNDO THIS CHANGE" (confirm dialog) · PrimaryButton
"UNLOCK ANOTHER FEATURE →" · BottomNav.

**Desktop app** — top bar (logo, nav tiles, car chip with thumbnail, CONNECTED
badge) · 3 columns that wrap: sections sidebar (≤260px) · feature list ·
detail panel (≤440px, `--surface-2`). Same components as mobile.

**Desktop landing** — header (logo, CARS, HOW IT WORKS, OPEN APP) · hero
("your car can do more. turn it on." with "turn it on." in yellow) + preview card
with a 10px yellow plunk · yellow trust strip (NO ACCOUNT · NO SUBSCRIPTION ·
NOTHING PERMANENT · EVERY CHANGE CHECKED) · supported-cars grid · 3 steps · 3 safety
points · white CTA block with yellow plunk · footer disclaimer "Not affiliated
with Škoda or Volkswagen."

## 7. States you must build (not drawn in every screen)

- Coding outcomes on screen 5→6: **success** (green, above) · **ECU still
  saving** (keep the active white StepCard, show elapsed time, never a spinner
  alone) · **refused, nothing changed** (neutral card: "your car said no —
  nothing was changed") · **can't confirm** (yellow WarningBar: "we couldn't
  confirm the result. tap check again before doing anything else", with a
  "CHECK AGAIN" PrimaryButton and "UNDO THIS CHANGE"). Never show success unless
  the car confirmed the new setting.
- Connect errors: adapter not found, Bluetooth off, wrong car (VIN mismatch →
  stop, show both).
- Unknown variant: the model's features are listed the same way as for any
  variant (available / not available for your car).

## 8. Car images

`public/cars/<brand>-<model>/<colour>.webp` holds transparent side profiles per
colour; `src/data/car-images.json` maps each model's colours (and an icon). Use the
colour image in CarHero and swatches. Fallback when a model has no colours (Kodiaq,
Polo) or no folder (Octavia, Rapid, Vento): `public/cars/icons/<brand>-<model>.webp`
centred in the card. Hero photos for the feature list: `public/f/hero/<brand>-<model>.webp`.

Provenance: an earlier note here said these images came from Cars24 / VW India and had to
be replaced before launch. On 2026-10-25 the owner stated they are pictures from the
owner's own website, and they now ship by default (decision D4,
`docs/reviews/2026-10-25/FIXES.md`; `VITE_CAR_IMAGES=0` drops them).

## 9. Copy voice

Lowercase serif headlines ending in a full stop. Short, calm, factual. Never
"oops". Say what happened and what to do: "refused — nothing changed".
