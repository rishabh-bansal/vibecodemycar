# Feature catalogue: build spec (for Claude Code)

Scope: ONLY the feature browsing UI, meaning the Features list (mobile), the
Feature detail (mobile), and the Desktop catalogue. The rest of the app
(car picker, connect, coding, backups, tokens, Logo) already exists. Reuse the
existing NeoPOP tokens and components; do not add new colours or fonts.

Reference mockups: `screens/features.html`, `screens/detail.html`,
`screens/catalogue.html`. Open them in a browser from this folder. Copy their
layout, sizes and copy, not their inline-style markup.

---

## 1. Data

Source: `docs/features/<make>/<model>/features.json`, images in
`docs/features/img/` (feature `image` paths are relative to the model folder,
e.g. `../../img/<hash>.jpg`). Images are 2:1 (1024×512).

Show only these 8 India models, in this order:

| Škoda | Volkswagen |
|---|---|
| kushaq, slavia, kylaq, kodiaq, superb | taigun, virtus, tiguan |

The folders also contain other models (elroq, enyaq, fabia, kamiq, kamiq-cn, karoq,
octavia, rapid, roomster, scala…). Ignore them.

File shape: `{ make, model, title, bases, features: Feature[] }`.

```ts
type Feature = {
  slug: string; name: string;
  group: 'exterior-lighting'|'windows-locks'|'dashboard'|'assistance'|'comfort'|'service';
  category: string; image?: string; intro: string;
  Functions: string[]; Requirements: string[]; Attention: string[];
  'In-Car procedure': string[]; Notes: string[];
};
```

### Data cleaning (required, do it at load time in one `normalizeFeature()`)

The arrays are usually EMPTY. Their content is embedded in `intro`, split by
emoji markers. Example raw intro:

```
Automatically sweep the gauge needles … every time the Ignition is turned ON
⚙Functions
Turn ON or OFF needle sweep feature for your instrument cluster
⚠ Attention
First turn the ignition ON and then open the vehicle's hood to activate this feature
```

Rules:
1. Split `intro` on lines that start with `⚙` (→ Functions) or `⚠` (→ Attention),
   tolerating an optional space (`⚙Functions`, `⚙ Functions`, `⚠ Attention`).
   Also accept headings for Requirements / In-Car procedure / Notes if present.
2. Text before the first marker = the real intro (trimmed, first line).
3. Merge parsed lists with any non-empty arrays already in the JSON; dedupe.
4. `intro` may be `""` (e.g. Comfort Turn Signals). Then show photo + name only.
   Never render an empty section or heading.
5. Missing/broken image → dark `--surface` tile with the group icon; never a broken img.
6. Write a unit test with the needle-sweep, speed-warning-for-india and
   comfort-turn-signals records from `skoda/kushaq/features.json`.

### Unlocks vs Service tools

`group: "service"` items are tests, resets and readouts (Oil Service Reset,
Door Lock Test, Battery Type…), not unlocks. Separate them:

- **UNLOCKS** tab = every group except `service`. This is the default tab and the
  number in the headline. Kushaq: 33 unlocks, 22 service tools.
- **SERVICE TOOLS** tab = `service`. Same list/grid UI, no "most loved" hero.

Headline: `"{unlocks} things to unlock."` with micro-label `"+{service} SERVICE TOOLS"`.

### Group labels & order

| group | chip label | section title |
|---|---|---|
| exterior-lighting | LIGHTS | Lights |
| dashboard | DASH (mobile) / DASHBOARD | Dashboard |
| windows-locks | LOCKS (mobile) / LOCKS & WINDOWS | Locks & windows |
| assistance | ASSIST | Assistance |
| comfort | COMFORT | Comfort |
| service | (tab, not a chip) | Service tools |

Hide chips/sections with 0 items. Chips show counts.

### Support status per feature

The badge (✓ TESTED ON YOUR CAR / β EXPERIMENTAL / unavailable + reason)
comes from the app's existing support data (recipes/feature-matrix), joined by
`slug`. The catalogue JSON has no status. A feature with no join → shown as
**"NOT YET CODABLE"** (grey, `--ink-off`): still browsable, but the CTA is
disabled with that label. Never invent a status.

### Legal warnings

If Attention mentions law ("against the law", "legal", "required by law"),
show the Attention card in the detail ABOVE the CTA and require one extra tap
("I UNDERSTAND"), turning it into the CTA. Never put such a feature in the "most loved" hero.

## 2. Mobile Features list (`screens/features.html`)

Top to bottom:
1. Header: Logo (left) · car chip (right, white tile + plunk, car thumbnail +
   `MODEL ▾`, opens existing car picker).
2. H1 display `33 things\nto unlock.` + right micro-label `+22 SERVICE TOOLS`.
3. Segmented control: `UNLOCKS · 33` | `SERVICE TOOLS · 22` (selected = white).
4. Group chips, horizontally scrollable, `ALL` selected = yellow + plunk.
   Single-select on mobile.
5. **Hero card** (only on UNLOCKS + ALL): 176px tall, photo `object-fit:cover`,
   bottom gradient to `--bg`, yellow `MOST LOVED` tag, serif name lowercased with
   full stop, one-line intro, white `→` tile. Shadow `6px 6px 0 var(--yellow)`.
   Pick: first feature in a config list `HERO_SLUGS` that this car has and that
   is TESTED; fallback first TESTED unlock; else no hero.
6. Sections in group order. Each: micro-label `LIGHTS · 16` + `SEE ALL →`
   (sets the chip). Under ALL, show max 3 rows per section; with a chip selected,
   show all.
   - Lights / Locks / Assist / Comfort / Service: **photo row**, 8px padding,
     88×44 thumb, name (700 14px), status label (micro, coloured), `→`.
   - Dashboard: **2-up photo card grid** (2:1 image, name below).
     (Use grid for whichever section has the best photos; Dashboard by default.)
7. Floating BottomNav (existing component). Leave 100px bottom padding so the
   last row clears it.

Search: a search icon button in the header opens a full-width input
(filters current tab by name + intro, case-insensitive). Show `N of M` under the
headline while filtering; empty → "nothing matches “xyz”." + CLEAR button.

## 3. Mobile Feature detail (`screens/detail.html`)

1. Hero photo 250px, full-bleed, gradient top (for the back button) and bottom
   into `--bg`. Back = white 44px tile + plunk, top-left at safe-area. Group
   tag top-right (translucent black, 1px line).
2. Content overlaps the photo by 34px: status badge, H1 serif lowercased name
   with full stop, intro (`--ink-2`, 14px).
3. `SET IT` choice tiles, from the existing recipe (toggle → On / Off·factory;
   options → one tile each; scalar → stepper). Selected = white + plunk.
4. Attention card(s): bg `#1a1708`, border `#5c4f10`, yellow 28px `!` tile,
   micro-label `BEFORE YOU START`, text 13px/600. One card per Attention item.
5. Functions (if any besides the obvious toggle): micro-label `WHAT IT DOES` +
   bullets. Requirements: `YOU'LL NEED`. In-car procedure: `IN THE CAR`
   numbered list. Notes: `GOOD TO KNOW`. Only render non-empty.
6. StatGrid TIME / BACKUP / UNDO (existing).
7. Sticky bottom PrimaryButton `CODE THIS FEATURE →` → existing connect flow.
   If content is taller than the viewport, the page scrolls; the CTA stays.

Rewrite source text lightly for display: sentence case, "hood" → "bonnet",
drop trailing "this feature". Do this in a small `displayCopy()` util, not by editing JSON.

## 4. Desktop catalogue (`screens/catalogue.html`)

Three columns, wrapping on narrow widths:
- **Left rail 240–250px:** Logo; `ŠKODA` / `VOLKSWAGEN` micro-labels; car rows
  `name … count` (count = total features). Selected = white tile + plunk.
  Switching car is instant (all 8 JSON files loaded up front).
- **Main:** car side-profile image (existing car assets) + micro-label
  `ŠKODA KUSHAQ · 55 FEATURES` + H1 `33 things to unlock.` + search
  (`/` focuses it). Segmented UNLOCKS / SERVICE TOOLS, then group chips.
  Desktop chips are multi-select (ALL clears). Sections with
  `repeat(auto-fill, minmax(220px,1fr))` photo cards. Selected card = white
  fill + `6px 6px 0 var(--yellow)`.
- **Detail panel 380–420px** (right, `--surface-2`): 16:9 photo, ✕ close
  (white tile), same content order as mobile detail, CTA at bottom. On
  < 1100px it becomes a slide-over with a dark backdrop; Esc / ✕ / backdrop
  closes. Panel closes when the car changes.

Keyboard: `/` search · arrow keys move between cards · Enter opens ·
Esc closes panel, then clears search.

## 5. Behaviour

- Filters compose: car × tab × chips × search. URL keeps state
  (`?car=kushaq&tab=unlocks&g=dashboard&q=…&f=<slug>`) so links are shareable
  and Back works.
- Images: `loading="lazy"`, fixed aspect-ratio boxes (no layout shift),
  `alt` = feature name.
- Touch targets ≥44px. Rows/cards are `<a>`/`<button>`, not divs.
- No loading spinner after first boot; first boot shows skeleton cards
  (surface blocks with the same sizes).

## 6. Acceptance checks

- Kushaq shows 33 unlocks / 22 service tools; each of the 8 cars loads.
- Needle Sweep detail shows the intro, one Attention card (bonnet), and no
  empty sections.
- Comfort Turn Signals detail shows photo + name + controls only.
- Speed Warning for India shows the legal Attention card + I UNDERSTAND gate,
  and never appears as hero.
- No other models appear. No broken images.
