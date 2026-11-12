# Feature coverage — catalogue slugs vs codable recipes

Generated 2026-11-01, summary numbers and the exterior-lighting tables regenerated 2026-11-03 after the recipe audit, from `src/data/app-data.json`, `src/data/catalogue.json`, `data/source/overlays/*.json` and `data/source/catalogue-map/*.json`. Codability follows the runtime exactly (`src/domain/catalog/features.ts` `recipeIdFor` + `hasBytes`, joined by `src/domain/catalogue/status.ts` `appFeatureIds`: slug, then `aliasOf`, then `CATALOGUE_ALIASES`). A slug is "not codable" only when no byte-level recipe resolves for the model's platform.

## Platform families (2026-11-03)

Sister cars share their electrics, so features are now offered per **platform family**, not per model catalogue (`src/domain/catalog/platform.ts`):

- **MQB-A0-IN** (India 2.0): Škoda Kushaq, Slavia, Kylaq; VW Taigun, Virtus. Same 2Q0 937 08x body computer family and the same instrument clusters.
- **MQB** (MQB-37 / MQB-B in the data): Škoda Kodiaq, Octavia RS, Superb; VW Tiguan, Tayron, Golf GTI.

A catalogue slug listed on any model of a family is offered on every model of that family, with the family's recipe (`recipeByPlatform` key = family; the engine still picks each module's exact variant from its part number on connect). Each model's catalogue cards are the union across its family: its own cards first with its own text, then its sisters' (`withFamilyFeatures`). A cluster requirement is the model's own when its catalogue lists the feature, else its sisters' when they all agree (`clusterRequirement`). Models without a build list (Kodiaq, Superb, Tiguan) now reach the app through a model-level listing id (`scripts/build-data.mjs`).

**Other model**: each brand's picker ends with "Other model". On connect the body computer's part number (F187 of unit 09) names the family (2Q0 → MQB-A0-IN; 5Q0 / 3Q0 / 5WA → MQB); until then, or for a part we don't know, it shows the MQB-A0-IN family and says it will be confirmed. The detected family is stored in `selection.detected.platform` (with `bcmPart`) and persisted.

### Per model, before → after

Codable = app features with bytes to write for the car (`featuresFor`, the Features headline); cards = catalogue cards shown for the model (codable cards in brackets), both as the runtime resolves them before and after.

| Model | Family | Codable features before → after | Cards before → after (codable) |
|---|---|---|---|
| Škoda Kushaq | MQB-A0-IN | 57 → 130 | 55 (33) → 171 (104) |
| Škoda Slavia | MQB-A0-IN | 71 → 130 | 71 (47) → 171 (104) |
| Škoda Kylaq | MQB-A0-IN | 75 → 130 | 117 (64) → 171 (104) |
| VW Taigun | MQB-A0-IN | 28 → 130 | 30 (3) → 171 (104) |
| VW Virtus | MQB-A0-IN | 100 → 130 | 115 (74) → 171 (104) |
| Škoda Kodiaq | MQB | 11 → 25 | 22 (0) → 52 (13) |
| Škoda Superb | MQB | 0 → 25 | 44 (0) → 52 (13) |
| VW Tiguan | MQB | 10 → 25 | 37 (1) → 52 (13) |
| Škoda Octavia RS | MQB | 0 → 25 | none → 52 (13) |
| VW Tayron | MQB | 0 → 25 | none → 52 (13) |
| VW Golf GTI | MQB | 0 → 25 | none → 52 (13) |
| Other model (either brand) | MQB-A0-IN until connect, then as read | — → 130 (MQB: 25) | — → 171 (104) (MQB: 52 (13)) |

(slug, model) listings across the 8 catalogue models: 491 → **1011**; codable on the car as the app resolved it: 222 → **559** (the 244 in the summary below counted a slug codable wherever any recipe existed, but before families the Kodiaq, Superb and Tiguan catalogue slugs never reached those cars). The per-slug tables below still list the models whose own catalogue names each slug; every sister of the family now gets it too.

### Recipe audit (2026-11-03)

Every mapped recipe in the six groups was re-checked against the vendor C#, the catalogue text and both families. Codable features per car: MQB-A0-IN **121 → 130** (cards 171 (95) → 171 (104)); MQB **25 → 25** (52 (13), unchanged). Catalogue slugs codable: 103 → **112**; own-catalogue listings codable: 247 → **268**; family listings codable: 514 → **559**.

Newly codable (all MQB-A0-IN only, BCM 09 lamp records, login 31347; none of these records has been written on a car yet, and 0564/0565/0566/0569 have not been read on the Kushaq, so each recipe refuses unless the record is in a state it recognises):

| Slug | Recipe | Change | Confidence |
|---|---|---|---|
| third-brake-light-when-trunk-open | `el-third-brake-light-trunk-open` | 0566 C = 0x21 at 100%, needs A = 0x18 | high |
| third-brake-light-with-drl | `el-third-brake-light-drl` | 0566 E = 0x14 at 10%, needs A = 0x18 | high |
| license-plate-lights-with-trunk-open | `el-license-plate-trunk-open` | 0569 C = 0x21: on at 100%, or off (0%, minimise) | high (on), med (off-when-open) |
| third-brake-light-with-coming-leaving-home-lights | `el-third-brake-light-ch-lh` | 0566 G = 0x1E at 100%, needs A = 0x18 | med |
| brake-lights-when-trunk-open | `el-brake-lights-trunk-open` | 0564/0565 C = 0x21 at 100%, needs A = 0x18 | med |
| taillights-when-trunk-open | `el-taillights-trunk-open` | 0567/0568 E = 0x21 at 100%, needs A = 0x08 | med |
| license-plate-lights-with-drl | `el-license-plate-drl` | 0569 E = 0x14 at 100% | med |
| turn-signals-with-ch-lh | `el-turn-signals-ch-lh` | 0550/0551 G = 0x1E at 100%, needs A = 0x02/0x04 | med |
| fogs-off-with-high-beams | `el-fogs-off-with-high-beam` | 055C/055D G = 0x0D/0x0E at 0%, minimise; refuses while fog-with-high-beam or flash-to-pass uses G/H | med |
| drl-on-with-parking-lights | `el-drl-with-parking-lights` | 0552/0553 dim CD 0x1C → 0x64 (needs C = 0x08) | med |

No longer codable: **cornering-light-dimming-rate** (its recipe set the legal regulation regime, not a fade speed; no vendor routine sets a corner ramp).

Audit fixes to existing recipes: comfort-turn-signals on MQB now uses `el-comfort-turn-signals` (new BCM 0A5E or old BCM 0D00 by the Unit09 check); `csadapt-10335` (car settings while moving) writes only on MIB3; `wl-anti-theft-alarm` refuses "On" when a siren is set; lock-unlock-sound-settings no longer offers "Via horn short"; `csadapt-10044` is bounded to 5..15 km/h; `svc:oil-change-service-distance` gains 25,000 km. These change what is written (or refused), so backups made with the earlier definitions refuse with `target-changed` rather than restore.

## Summary

- Catalogue slugs: **194**; codable: **112**; not codable: **82**.
- (slug, model) listings: **491**; codable: **268**.
- Consumer copy (`data/source/feature-copy.json`, merged by `scripts/build-data.mjs`): every codable feature has a display name, a 1-2 sentence description and a label for each setting — **146** features (112 catalogue slugs + 34 earlier-list features). The Name and Settings columns below show that copy.
- Codability never differs between models for the same slug (every mapped slug resolves a recipe on every platform it is listed on).
- Before → after: before, 41 slugs were aliased to legacy matrix features and 26 of those were executable. After: every slug is its own app feature; **112** slugs are codable through their own catalogue-map recipe (0 depend on an alias join). 35 slugs still carry `aliasOf` for backup compatibility.
- `npx vitest run`: 1467 passed, 63 skipped (79 files), re-run after the 2026-11-03 audit landed.

### By group (slugs)

| Group | Slugs | Codable | Not codable |
|---|---|---|---|
| assistance | 19 | 8 | 11 |
| comfort | 44 | 23 | 21 |
| dashboard | 29 | 22 | 7 |
| exterior-lighting | 51 | 35 | 16 |
| service | 35 | 10 | 25 |
| windows-locks | 16 | 14 | 2 |
| **total** | 194 | 112 | 82 |

### By model (listings, each model's own catalogue — before platform families; see the table above for after)

| Model | Listed | Codable | Not codable |
|---|---|---|---|
| kushaq | 55 | 36 | 19 |
| slavia | 71 | 54 | 17 |
| kylaq | 117 | 73 | 44 |
| kodiaq | 22 | 4 | 18 |
| superb | 44 | 10 | 34 |
| taigun | 30 | 3 | 27 |
| virtus | 115 | 79 | 36 |
| tiguan | 37 | 9 | 28 |

### By group × model (codable / listed)

| Group | kushaq | slavia | kylaq | kodiaq | superb | taigun | virtus | tiguan |
|---|---|---|---|---|---|---|---|---|
| assistance | 3/4 | 3/5 | 3/7 | 0/1 | 0/1 | 1/7 | 2/11 | 3/6 |
| comfort | 2/2 | 4/5 | 12/20 | 2/2 | 4/9 | 0/1 | 15/25 | 4/7 |
| dashboard | 7/7 | 7/7 | 9/11 | 0/2 | 4/11 | 0/1 | 18/18 | 0/2 |
| exterior-lighting | 12/16 | 22/32 | 28/41 | – | 0/1 | 0/1 | 22/27 | – |
| service | 9/22 | 8/12 | 9/25 | 2/17 | 2/22 | 2/20 | 10/20 | 2/22 |
| windows-locks | 3/4 | 10/10 | 12/13 | – | – | – | 12/14 | – |

### Codable slugs by recipe kind

- alt: 36
- group: 28
- field: 29
- ops: 9
- scalar: 9
- field (MQB-A0-IN) / alt (MQB): 1 (comfort-turn-signals)

### Password source (codable slugs)

- recipe: 71
- unit-default: 36
- mixed: 5

Unit defaults (contract): 09=31347, 17=47115, 44=19249, 6D=12345, 01=27971, 10=71679, 18=80782, others 20103.

## Per-slug detail

Columns: models listing the slug (all share the status shown), recipe id and kind, unit/DID (groups list each step, alts each variant), settings offered (scalar recipes also accept a free `value:<n>`), password (value and source).

### assistance

#### Codable

| Slug | Name | Models | Recipe | Kind | Unit/DID | Settings | Password |
|---|---|---|---|---|---|---|---|
| adaptive-lane-guidance | Adaptive Lane Guidance | tiguan | `assist:adaptive-lane-guidance` | group | A5/0600 + 5F/0B3D\|5F/0B1D + A5/09A3 + A5/09A4 | On; Off | 20103(recipe),20103(unit-default) |
| esc-asr-deactivation | ESC Menu Options | kushaq, slavia, kylaq | `csmqb-mqb-03-escmenu` | ops | 03/0600 | No menu; ESC On / ASR Off; ESC On / ESC Sport; ESC On / ESC Off; ESC On / ASR Off / ESC Off; ESC On / ESC Sport / ESC Off; ESC On / ASR Off / ESC Off (alternative); ESC On / ESC Sport / ESC Off (alternative); ESC On / ASR Off / ESC Sport; ESC On / ASR Off / ESC Sport (alternative) | 20103(unit-default) |
| high-beam-assist-memory | High Beam Assist Memory | kushaq | `csmqb-high-beam-assistant-save-state` | alt | 09/0A60\|09/0D0C | On; Off | 31347(recipe) |
| hill-hold-assist | Hill Hold | kushaq, slavia, kylaq, virtus | `csmqb-mqb-03-hill-hold-control-activation` | field | 03/0600 | On; Off | 20103(recipe) |
| hill-start-assist-settings | Hill Start Release Point | slavia, kylaq | `csadapt-10005` | field | 03/0E0D | Normal; Early (lower RPM); Late (higher RPM) | 20103(recipe) |
| lane-assist-setting-memory | Lane Assist at Start-Up | tiguan | `assist:lane-assist-save-state` | alt | A5/0600 | Off; On; Remember last setting | 20103(recipe) |
| lane-assist-wheel-vibration | Lane Assist Wheel Vibration | tiguan | `csadapt-10137` | field | A5/0600 | Off; On; Choose in multimedia menu | 20103(unit-default) |
| park-assist-switch-off-speed | Parking Sensors Off Speed | taigun, virtus | `csadapt-10044` | scalar | 10/25E9 | — (+ free value, 5..15 km/h) | 71679(unit-default) |

#### Not codable

| Slug | Models | Reason / search provenance |
|---|---|---|
| acc-distance-settings-menu | kushaq, slavia, kylaq, taigun, virtus, tiguan | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords ACC, distance, Abstand, menu, 13/5F, BAP vehicle function list (0B1D/0B3D). Only ACC_OperationMode, ACC_WaitTime, OvertakingRightPrevention, cruise activation exist. |
| alternating-park-position-for-wipers | kylaq, virtus | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords wiper, Wischer, alternat, Wechsel, park position. Wiper recipes cover start/end/service position, park after ignition off/hood open, teardrop, rear wiper. |
| brake-check-when-using-acc | slavia, kylaq, virtus | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords hazard, Warnblink, brake, Brems, ACC. Lead only: MQB_LightConfigurationCoding lists BCM lamp channel 15 "35 LED Warnblinktaster C48" at 09/055F (generic Leuchte editor, function codes from embedded mqb_light_functions); no vendor recipe states which function/slot to set, so no bytes are derived. |
| front-park-assist-volume | taigun, virtus | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords park, PDC, Einparkhilfe, tone, beep, volume, 70A/unit 10/76. Unit 10 only has 25E9 deactivation speed and 0600 lane-assist patch; park-pilot 0x1000 datasets are undecoded. |
| front-parking-assist-tone | taigun, virtus | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords park, PDC, Einparkhilfe, tone, beep, volume, 70A/unit 10/76. Unit 10 only has 25E9 deactivation speed and 0600 lane-assist patch; park-pilot 0x1000 datasets are undecoded. |
| high-beam-without-ignition | kylaq | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords flash, Lichthupe, high beam, Fernlicht, ignition, Zuendung. High-beam recipes are HBA step1-3, HBA save state and fog-with-high-beam only. |
| lane-assist-information-message | tiguan | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords lane, message, warning, info, A5/17. A5 recipes: activation (3 cameras), TJA, save state, adaptive, vibration, road sign; 17 warnings: speed, icy, leaving, seat belt. |
| optical-parking-system | virtus | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords OPS, optical, park, camera, 5F/10. 5F camera recipes only set rear camera installed. |
| park-assist-activation-tone | kodiaq, superb, taigun, virtus, tiguan | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords park, PDC, Einparkhilfe, tone, beep, volume, 70A/unit 10/76. Unit 10 only has 25E9 deactivation speed and 0600 lane-assist patch; park-pilot 0x1000 datasets are undecoded. |
| rear-park-assist-volume | taigun, virtus | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords park, PDC, Einparkhilfe, tone, beep, volume, 70A/unit 10/76. Unit 10 only has 25E9 deactivation speed and 0600 lane-assist patch; park-pilot 0x1000 datasets are undecoded. |
| rear-parking-assist-tone | taigun, virtus | no recipe mapped for platform. no-implementation: searched: feature-recipes.json (571), VAGCoder carscanner-candidates.json (711) by featureName/builder, all 101 *.decompiled.cs by codingDB_* keys and literal strings, decoded mqbadaptations.db (346 records) by name/unit; keywords park, PDC, Einparkhilfe, tone, beep, volume, 70A/unit 10/76. Unit 10 only has 25E9 deactivation speed and 0600 lane-assist patch; park-pilot 0x1000 datasets are undecoded. |

### comfort

#### Codable

| Slug | Name | Models | Recipe | Kind | Unit/DID | Settings | Password |
|---|---|---|---|---|---|---|---|
| air-recirculation-memory | Air Recirculation Memory | virtus | `csadapt-10011` | field | 08/0AEB | Off; On; Depends on parking time | 20103(unit-default) |
| allow-car-settings-while-moving | Car Settings While Driving | virtus | `csadapt-10335` | alt (MIB3 only) | 5F/0B1B | Unlocked; Locked | 31347(recipe) |
| am-radio | AM Radio | virtus | `csmqb-mqb-5-f-amradio` | alt | 5F/0600\|5F/0559 | On; Off | 20103(recipe) |
| comfort-operation-for-sunroof | Sunroof by Key Remote | kylaq, virtus | `csmqb-automatically-open-and-close-sunroof-holding-key-fob-keys` | alt | 09/0A76\|09/0D0D | On; Off | 31347(recipe) |
| coming-home-time | Coming Home Duration | slavia, kylaq, virtus | `csadapt-10188` | scalar | 09/0A57 | — (+ free value) | 31347(recipe) |
| easy-entry | Easy Entry (Driver Seat) | superb, tiguan | `group:comfort-entry-driver-seat` | group | 36/0600 + 5F/0B3C\|5F/0B1B + 5F/0B3D\|5F/0B1D | On; Off | 20103(unit-default) |
| easy-entry-for-passenger | Easy Entry (Passenger Seat) | superb, tiguan | `group:comfort-entry-passenger-seat` | group | 06/0600 + 5F/0B3C\|5F/0B1B + 5F/0B3D\|5F/0B1D + 36/0600 | On; Off | 20103(unit-default) |
| front-windshield-heater-duration | Heated Windshield Timer | virtus | `csadapt-10039` | scalar | 09/0D06 | — (+ free value) | 31347(recipe) |
| green-engineering-menu-discover | Multimedia Developer Menu | virtus | `csmqb-mqb-5-f-developer-mode-activation` | ops | 5F/243F | On; Off | 20103(unit-default) |
| haldex-awd-settings | All-Wheel Drive Mode | kodiaq, superb, tiguan | `csadapt-10001` | field | 22/0C0A | Standard; More traction; Less noise | 20103(unit-default) |
| hazard-switch-brightness | Hazard Switch Brightness | kylaq | `csadapt-10287` | scalar | 09/09DB | — (+ free value) | 31347(recipe) |
| heated-seats-memory | Heated Seats Memory | kylaq, virtus | `comfort:heated-seats-memory` | group | 08/264D + 08/27D9 | Off; On; On for 10 minutes | 20103(unit-default) |
| low-ambient-temperature-warning | Ice Warning Temperature | slavia, kylaq | `csadapt-10186` | scalar | 17/050E | — (+ free value) | 47115(recipe) |
| microphone-sensitivity | Microphone Sensitivity | virtus | `csadapt-10013` | scalar | 5F/241E | — (+ free value) | 20103(recipe) |
| multimedia-startup-logo | Multimedia Startup Logo | kylaq, virtus | `comfort:multimedia-startup-logo` | alt | 5F/0600\|5F/0556 | Standard; Skoda vRS (with stripes) / VW Twin Drive; Skoda Scout / VW GTD; Skoda Laurin & Klement / VW GTI; Skoda Greenline or Scout Line / VW BlueMotion; Skoda or Skoda Monte Carlo / VW e-Golf; VW R-Line; Skoda Monte Carlo / VW R; Skoda (facelift) / VW Alltrack; Skoda vRS (no stripes) / VW GTE; Skoda Scout (facelift) / VW Elegance; Skoda Laurin & Klement (facelift) / VW MAN; Skoda Monte Carlo (facelift); Skoda Sportline / VW blank screen; Skoda vRS (facelift); Style 15; VW Beats Audio; VW Family | 20103(unit-default) |
| navigation-compass-in-dashboard | Navigation in Dashboard | kylaq, virtus | `csadapt-10183` | field | 17/0600 | On; Off | 47115(unit-default) |
| pulsation-of-start-button | Pulsing Start Button | kushaq, slavia, kylaq, virtus | `csmqb-start-button-heart-bit` | alt | B7/0574\|B7/1304 | On; Off | 20103(recipe) |
| rear-windshield-heater-duration | Rear Window Heater Timer | kylaq, virtus | `csadapt-10037` | scalar | 09/0D06 | — (+ free value) | 31347(recipe) |
| rear-wiper-automatic-activation | Automatic Rear Wiper | kushaq, slavia, kylaq | `csmqb-mqb-09-auto-rear-wiper` | alt | 09/0D20 | On; Off | 31347(recipe) |
| remote-trunk-release | Open Trunk by Key Remote | kylaq, virtus | `csadapt-10081` | field | B7/0579 | On; Off | 20103(recipe) |
| start-stop-system-deactivation | Start/Stop System | kylaq | `csadapt-10105` | field | 08/0600 | On; Off | 20103(unit-default) |
| teardrop-wiping | Teardrop Wipe | virtus | `group:teardrop-mode-additional-wipers-pass-on-the-windshield` | group | 09/0A72\|09/0D05 + 09/6001 | On; Off | 31347(recipe) |
| trunk-opening-closing-sound | Power Trunk Warning Sound | kodiaq, superb, tiguan | `csmqb-mqb-6-d-tailgate-sound` | field | 6D/0502 | On; Off | 12345(recipe) |

#### Not codable

| Slug | Models | Reason / search provenance |
|---|---|---|
| allow-media-settings-while-moving | virtus | no recipe mapped for platform. no-implementation: searched moving\|nhtsa\|media\|standstill: only MIB3 0B1B byte23 dashboard-menu availability bits (10331-10336) and MQB_5F_NHTSA_NoSoftKeyboard (CarPlay keyboard only) |
| allow-phone-settings-while-moving | virtus | no recipe mapped for platform. no-implementation: searched moving\|nhtsa\|phone: no phone-menu speed lock (NHTSA_NoSoftKeyboard is CarPlay keyboard only) |
| allow-radio-settings-while-moving | virtus | no recipe mapped for platform. no-implementation: searched moving\|nhtsa\|tuner\|radio: no tuner-menu speed lock |
| automatic-pdc-activation | taigun, virtus | no recipe mapped for platform. no-implementation: searched pdc\|park\|einpark\|unit 10/76: only csadapt-10044 park-assist deactivation speed, park-assist patches for lane assist / TPMS |
| brake-pad-warning | kylaq | no recipe mapped for platform. no-implementation: searched brake\|pad\|belag\|wear: only ESC/HHC/XDS/brake-booster/bleeding; no pad-wear sensor coding |
| dashboard-startup-logo | kylaq | no recipe mapped for platform. no-implementation: searched logo\|startup\|Begruessung in C# and candidates: only 5F startup screen (10077/10231), 5F badge 10111, VW RLogo 0E4E (10135); csadapt-10078 is an unlabelled raw 0600 block. No cluster logo byte |
| dashboard-view-change-animation | superb | no recipe mapped for platform. no-implementation: searched anim\|animation\|transition in C# and candidates: nothing |
| digital-speed-in-dashboard | virtus | no recipe mapped for platform. no-implementation: searched digital\|speed\|tacho in Dashboard.cs and candidates: only 120 km/h warning, speed warnings (228C/0E46), and csadapt-10030 0D60 style (unlabelled values) |
| engine-preheat | superb | no recipe mapped for platform. no-implementation: searched preheat\|vorwaerm\|heater\|N279\|unit 18 / Webasto: only parking heater procedures and alarm parking-heater flag |
| engine-speed-rpm-in-dashboard | kylaq | no recipe mapped for platform. no-implementation: searched rpm\|tacho\|drehzahl: Dashboard.cs has FreeSpaceInFuelTank/LapTimer/OilTemp/Acceleration/OutsideTemp/SoC/120kmh only; csadapt-10030 0D60 speedometer style is unlabelled 0-15 |
| fm-radio-settings | virtus | no recipe mapped for platform. no-implementation: searched radio\|fm\|tuner\|region\|raster: only AM radio enable, RadioArtDB country list and csadapt-10083/10189 MIB3 country codes (not the EU/NAR/JP tuner raster) |
| increased-engine-responsiveness | kylaq | no recipe mapped for platform. no-implementation: searched unit 01 / engine / throttle / brand: only IdleRPMAdaptationDiesel, DPF, ThrottleAdaptationRoutine (basic setting), no engine brand coding |
| leaving-home-time | slavia, kylaq, virtus | no recipe mapped for platform. no-implementation: searched C# corpus (ExteriorLights ComingHomeLamps/ComingHomeActivation/ComingHomeActivationEvents, all 0A57/0D04 users) and candidates for leav\|home\|Abschied: only coming-home duration (csadapt-10188 0A57 byte5) exists; no leaving-home duration byte |
| multimedia-safety-disclaimer | virtus | no recipe mapped for platform. no-implementation: searched disclaimer\|warning screen\|nhtsa: only csadapt-10333 (MIB3 dashboard-menu "after disclaimer" availability), catalogue says MIB3 unsupported; no MIB2 disclaimer bit |
| phone-in-dashboard | kylaq, virtus | no recipe mapped for platform. no-implementation: searched phone\|telef\|tele: only MQB_5F_SecondPhoneSupport, csadapt-10232 antenna, csadapt-10114 SMS menu; no cluster phone menu |
| signal-horn-always-operable | kylaq | no recipe mapped for platform. no-implementation: searched horn\|hupe\|signal: only Alarm_UseSignalhorn, AcousticFeedbackSignalHorn, AcousticFeedbackDuration... (lock feedback), no terminal-15 horn availability |
| soundaktor | tiguan | no recipe mapped for platform. no-implementation: searched sound\|aktor\|A9\|soundaktor: only alarm siren, MIB sound datasets, 47 amp preset, 6D tailgate beep and lock confirmation sound; no unit A9 coding |
| speed-dependent-wipers | kylaq | no recipe mapped for platform. no-implementation: searched Washer.decompiled.cs (all 18 builders) and candidates for wiper\|wisch\|speed\|geschw: no speed-dependent wiper bit |
| sunroof-action-via-remote | superb, virtus, tiguan | no recipe mapped for platform. no-implementation: searched Roof.decompiled.cs: the key-fob sunroof delegate sets 2 bits together (open+close), no tilt/slide selection |
| sunroof-with-door-open | superb, tiguan | no recipe mapped for platform. no-implementation: searched Roof.decompiled.cs (AutomaticallyOpenAndCloseSunroofHoldingKeyFobKeys, EnableRoofInteriorLights) and sunroof\|roof\|schiebedach: no door-open stop behaviour |
| transmission-temperature | superb | no recipe mapped for platform. no-implementation: searched transmission\|getriebe\|gear\|temperature display: only MQB_17_OilTemperatureDisplay (engine oil) and Haldex anti-hum/impact |

### dashboard

#### Codable

| Slug | Name | Models | Recipe | Kind | Unit/DID | Settings | Password |
|---|---|---|---|---|---|---|---|
| acceleration-display | Acceleration Display | superb | `csmqb-mqb-17-acceleration-display` | field | 17/0600 | On; Off | 47115(unit-default) |
| consumption-display-correction | Fuel Consumption Correction | slavia, kylaq | `csadapt-10041` | scalar | 17/2234 | — (+ free value) | 47115(unit-default) |
| consumption-display-units | Fuel Consumption Units | virtus | `csadapt-10132` | field | 17/0600 | mpg (UK); mpg (US); L/100 km; km/L | 47115(unit-default) |
| date-display-format | Date Format | virtus | `csadapt-10131` | field | 17/0600 | DD.MM.YY; MM.DD.YY; YY.MM.DD | 47115(unit-default) |
| distance-display-units | Distance Units | virtus | `csadapt-10125` | field | 17/0600 | Kilometers; Miles | 47115(unit-default) |
| efficiency-assist-display | Eco Driving Screen | virtus | `csmqb-mqb-5-f-eco-driving` | alt | 5F/0B3C\|5F/0B1B | On; Off | 20103(unit-default) |
| fan-level-display-when-auto | Fan Speed in AUTO Mode | slavia, kylaq, virtus | `csmqb-mqb-08-blower-display-in-auto` | field | 08/0600 | On; Off | 20103(unit-default) |
| gauge-test-needle-sweep | Needle Sweep | kushaq, slavia, kylaq, virtus | `live-instrument-cluster-needle-sweep` | field | 17/0600 | On; Off | 47115(recipe) |
| lap-timer | Lap Timer | kushaq, slavia, kylaq, superb, virtus | `csmqb-mqb-17-lap-timer-display` | field | 17/0600 | On; Off | 47115(unit-default) |
| offroad-information-screen | Off-Road Screen | virtus | `group:show-offroad-screen-in-multimedia-system` | group | 5F/0B3C\|5F/0B1B + 5F/0B3D\|5F/0B1D + 5F/0600\|5F/0558 | On; Off | 20103(unit-default) |
| oil-temperature-display | Oil Temperature Display | kylaq, virtus | `csmqb-mqb-17-oil-temperature-display` | field | 17/0600 | On; Off | 47115(recipe) |
| refuel-quantity-in-dashboard | Refuel Amount Display | slavia, kylaq, superb, virtus | `csmqb-mqb-17-free-space-in-fuel-tank-display` | field | 17/0600 | On; Off | 47115(unit-default) |
| seat-belt-warning | Seat Belt Warning | kushaq, slavia, superb, virtus | `dash-seat-belt-warning` | alt | 17/22B9\|17/0600 | On; Off | 47115(unit-default) |
| seat-belt-warning-type | Seat Belt Warning Style | kylaq | `csadapt-10136` | field | 17/0600 | Off; Europe; USA; Europe (NCAP 2); Europe (NCAP 2 enhanced) | 47115(unit-default) |
| speed-display-units | Speed Units | virtus | `csadapt-10126` | field | 17/0600 | km/h; mph | 47115(unit-default) |
| speed-limiter | Speed Limiter | kushaq, kylaq, virtus | `dash-speed-limiter-activation` | group | 17/0AEA + 17/0AE7 + 17/0E4F + 13/0600 | On; Off | 20103(recipe) |
| speed-warning | Speed Warning | kushaq, slavia, kylaq, virtus | `dash-speed-warning` | ops | 17/228C | Off; 50 km/h; 60 km/h; 70 km/h; 80 km/h; 90 km/h; 100 km/h; 110 km/h; 120 km/h; 130 km/h; 140 km/h; 150 km/h; 160 km/h; 170 km/h; 180 km/h; 190 km/h; 200 km/h; 210 km/h; 220 km/h; 230 km/h; 240 km/h; 250 km/h | 47115(unit-default) |
| speed-warning-for-india | India Speed Chime | kushaq | `dash-speed-warning-india` | alt | 17/0E46\|17/0600 | On; Off | 47115(recipe) |
| steering-response | Steering Feel | kushaq, virtus | `csadapt-10048` | field | 44/1920 | Follow driving mode; Comfort; Automatic; Dynamic; Standard | 19249(recipe) |
| temperature-display-units | Temperature Units | virtus | `csadapt-10124` | field | 17/0600 | Celsius; Fahrenheit | 47115(unit-default) |
| time-display-format | Time Format | virtus | `csadapt-10123` | field | 17/0600 | 24-hour; 12-hour (AM/PM) | 47115(unit-default) |
| volume-display-units | Fuel Volume Units | virtus | `csadapt-10128` | field | 17/0600 | Liters; Gallons (UK); Gallons (US) | 47115(unit-default) |

#### Not codable

| Slug | Models | Reason / search provenance |
|---|---|---|
| engine-power-display | superb | no recipe mapped for platform. no-implementation: C# corpus for EnginePower\|Power\|kW\|SportView\|Boost (only lighting/window/TSC hits); candidates + mqbadaptations.db for power\|kw\|sport.*view\|leistung. Closest is csadapt-10082 DashboardSportViewCombination (0E42 ENABLE 01/DISABLE 00) with no description and no side/content selection, so it is not mapped as the kW display. |
| engine-torque-display | superb | no recipe mapped for platform. no-implementation: C# corpus for Torque\|Drehmoment (only MQB_44 TorqueSteeringCompensation); candidates + mqbadaptations.db for torque (EngineDragTorqueControl, unrelated). csadapt-10082 caveat as engine-power-display. |
| offroad-view-in-dashboard | superb | no recipe mapped for platform. no-implementation: C# corpus for Offroad\|OffRoad (only MQB_5F_OffroadModeDisplayInMMI_Var2, a 5F MMI screen, used for offroad-information-screen); candidates + mqbadaptations.db for offroad (only 10249/10050 ambient-colour profiles). No unit-17 cluster offroad / wheel-angle view exists. |
| speedometer-scale-range | kylaq, superb | no recipe mapped for platform. no-implementation: C# corpus for Speedometer\|Tacho\|Scale\|260\|MaxSpeed (no codingDB hit); candidates + mqbadaptations.db for scale\|speedomet\|tacho\|260\|280 -> only brightness calibrations 0505/0506 and csadapt-10030 ActiveInfoDisplaySpeedometerStyle (0D60, options 00..0F with no labels, nothing ties them to 260/280/300/320 end values). Not mapped. |
| steering-angle-display | kylaq, superb | no recipe mapped for platform. no-implementation: C# corpus (all 101 managed/*.cs) for codingDB_ names matching Lenkwinkel\|SteeringAngle\|WheelAngle\|FrontWheel; carscanner-candidates.json featureName/nameKey/builder for angle\|lenk\|wheel; mqbadaptations.db record names for angle. Only hits: wheel heater, Wheel Circumference (10191), steering-assist recipes - none is a cluster wheel-angle view. |
| traffic-sign-speed-warning | kodiaq, superb, tiguan | no recipe mapped for platform. no-implementation: C# corpus for RoadSign\|TrafficSign\|SpeedLimit\|Overspeed\|VZE\|warn.*speed; candidates + mqbadaptations.db for sign\|traffic\|overspeed. Only road-sign recognition activation (A5/17/5F groups, 3B63 patch, HUD 10237) and the fixed-threshold 228C / 0600 b0.6 warnings - no sign-based acoustic over-limit setting. |
| vehicle-path-display | kodiaq, superb, taigun, tiguan | no recipe mapped for platform. no-implementation: C# corpus for Trajector\|Fahrschlauch\|ParkingLines\|RearView\|Camera\|Path\|guide\|Hilfslinien\|ParkPilot and the 76C/6C units; candidates + mqbadaptations.db for path\|traject\|park.*line. Only RearCameraInstalled / camera washer / road-sign camera recipes - nothing for path/trajectory lines. |

### exterior-lighting

#### Codable

| Slug | Name | Models | Recipe | Kind | Unit/DID | Settings | Password |
|---|---|---|---|---|---|---|---|
| auto-headlights-settings | Auto Headlight Sensitivity | kylaq, virtus | `csmqb-light-sensor-sensivity` | alt | 09/0D0C | Early; Normal; Late | 31347(unit-default) |
| brake-lights-when-trunk-open | Brake Lights When Tailgate Open | slavia, kylaq, virtus | `el-brake-lights-trunk-open` (MQB-A0-IN only) | group | 09/0564 + 09/0565 | On; Off | 31347(recipe) |
| ch-lh-lights-variant | Coming Home Light Source | kylaq, virtus | `csmqb-coming-home-lamps` | alt | 09/0A57\|09/0D04 | Low beams; Fog lights | 31347(recipe) |
| comfort-turn-signals | Lane Change Blinks | kushaq, slavia, kylaq, virtus | MQB-A0-IN: `live-bcm-polite-blinks`; MQB: `el-comfort-turn-signals` | field / alt | 09/0A5E ; 09/0A5E\|09/0D00 | 2 blinks; 3 blinks; 4 blinks; 5 blinks | 31347(recipe) |
| coming-home-lights-activation-type | Coming Home Light Trigger | slavia, kylaq, virtus | `csmqb-coming-home-activation-events` | alt | 09/0A57\|09/0D04 | Ignition off; Driver door opened | 31347(recipe) |
| coming-home-lights-operation | Coming Home Lights | kushaq, slavia, kylaq, virtus | `csmqb-coming-home-activation` | alt | 09/0A57\|09/0D04 | Off; Manual; Automatic | 31347(recipe) |
| cornering-lights | Cornering Lights | slavia, kylaq, virtus | `group:corner-function-activation` | group | 09/055C + 09/055D + 09/0D1D | On; Off | 31347(recipe) |
| drl-activation-deactivation | Daytime Running Lights | slavia, kylaq, virtus | `csmqb-driving-lights-by-day` | alt | 09/0A58\|09/0D02 | Off; DRL lamps; Position or low-beam lights; Special mode | 31347(recipe) |
| drl-off-with-handbrake | DRL Off With Handbrake | kushaq, slavia, kylaq, virtus | `csmqb-turn-off-drlwhen-parking-brake-on` | alt | 09/0A58\|09/0D02 | On; Off | 31347(recipe) |
| drl-on-with-auto | DRL Only in AUTO | kushaq, slavia, kylaq, virtus | `csmqb-turn-off-drlwhen-light-switch-off` | alt | 09/0A58\|09/0D02 | On; Off | 31347(recipe) |
| drl-on-with-parking-lights | Full-Bright Side Lights | kylaq, virtus | `el-drl-with-parking-lights` (MQB-A0-IN only) | group | 09/0552 + 09/0553 | On; Off | 31347(recipe) |
| drl-settings-in-multimedia | DRL Option in Multimedia | kushaq, kylaq, virtus | `csmqb-drlsteup-in-mmi` | alt | 09/0A58\|09/0D02 | On; Off | 31347(recipe) |
| drl-with-fog-lights | Fog Lights as DRL | slavia, kylaq, virtus | `el-drl-with-fog-lights` (MQB-A0-IN only) | group | 09/055C + 09/055D | On; Off | 31347(recipe) |
| emergency-braking-lights | Emergency Braking Lights | kylaq | `el-emergency-braking-lights` | group | 09/0A59\|09/0D0C + 09/0A5E\|09/0D21 + 09/0A5E\|09/0D21 | Off; Brake lights; Turn signals; Brake lights and turn signals | 31347(recipe) |
| fog-lights-with-flash-to-pass | Fog Lights with Headlight Flash | slavia | `group:front-fog-lights-blink-with-high-beam-blink` | group | 09/055C + 09/055D | On; Off | 31347(recipe) |
| fog-lights-with-high-beam | Fog Lights with High Beam | slavia, kylaq | `group:front-fog-lights-activate-with-high-beam` | group | 09/055C + 09/055D | On; Off | 31347(recipe) |
| fogs-off-with-high-beams | Fog Lights Off with High Beam | virtus | `el-fogs-off-with-high-beam` (MQB-A0-IN only) | group | 09/055C + 09/055D | On; Off | 31347(recipe) |
| front-fog-lights-when-reversing | Fog Lights When Reversing | slavia, kylaq | `csmqb-turn-on-fog-lights-when-reversing` | alt | 09/0D1D | On; Off | 31347(recipe) |
| headlight-notification | Headlights-On Reminder | kushaq, slavia, kylaq, virtus | `csmqb-disable-turn-on-light-warning-09` | alt | 09/0A57 | Hidden; Shown | 31347(recipe) |
| headlight-washer | Headlight Washer Frequency | kushaq, slavia, kylaq, virtus | `csmqb-mqb-headlight-washer-interval` | alt | 09/0A73\|09/0D05 | — (+ free value) | 31347(recipe) |
| headlight-washer-activation-count | Headlight Washer Count | virtus | `csmqb-mqb-headlight-washer-interval` | alt | 09/0A73\|09/0D05 | — (+ free value) | 31347(recipe) |
| headlight-washer-activation-delay | Headlight Washer Delay | virtus | `csmqb-mqb-delay-before-headlight-washer` | alt | 09/0A73\|09/0D05 | — (+ free value) | 31347(recipe) |
| headlight-washer-activation-time | Headlight Washer Spray Time | virtus | `csmqb-mqb-headlight-washer-duty-duration` | alt | 09/0A73\|09/0D05 | — (+ free value) | 31347(recipe) |
| high-intensity-brake-light | Flashing Brake Lights | kylaq | `el-high-intensity-brake-light` | group | 09/0A59\|09/0D0C + 09/0A5E\|09/0D21 + 09/0A5E\|09/0D21 | On; Off | 31347(recipe) |
| led-license-plate-lamps | License Plate Bulb Type | virtus | `csmqb-license-plate-lamps-type` | ops | 09/0569 | 5W bulb; LED; LED (low power) | 31347(recipe) |
| license-plate-lights-with-drl | Number Plate Light with DRL | slavia, kylaq | `el-license-plate-drl` (MQB-A0-IN only) | ops | 09/0569 | On; Off | 31347(recipe) |
| license-plate-lights-with-trunk-open | Number Plate Light When Tailgate Open | slavia, kylaq, virtus | `el-license-plate-trunk-open` (MQB-A0-IN only) | ops | 09/0569 | On when open; Off when open; Default | 31347(recipe) |
| position-lights-with-turn-signals | Rear Lights Blink with Indicators | slavia, kylaq | `group:rear-side-lights-wink-with-rear-turn-lights` | group | 09/0567 + 09/0568 | On; Off | 31347(recipe) |
| scandinavian-drls | Tail Lights with DRL | kushaq, slavia, kylaq | `group:rear-side-lights-turn-on-when-daytime-running-lights-are-active-scandiavian-drls-name-skoda-kodiaq-etc` | group | 09/0567 + 09/0568 | On; Off | 31347(recipe) |
| taillights-when-trunk-open | Tail Lights When Tailgate Open | kylaq | `el-taillights-trunk-open` (MQB-A0-IN only) | group | 09/0567 + 09/0568 | On; Off | 31347(recipe) |
| third-brake-light-when-trunk-open | Third Brake Light When Tailgate Open | kushaq, slavia, kylaq | `el-third-brake-light-trunk-open` (MQB-A0-IN only) | ops | 09/0566 | On; Off | 31347(recipe) |
| third-brake-light-with-coming-leaving-home-lights | Third Brake Light with Coming Home | kushaq, kylaq | `el-third-brake-light-ch-lh` (MQB-A0-IN only) | ops | 09/0566 | On; Off | 31347(recipe) |
| third-brake-light-with-drl | Third Brake Light with DRL | kushaq, slavia, kylaq, virtus | `el-third-brake-light-drl` (MQB-A0-IN only) | ops | 09/0566 | On; Off | 31347(recipe) |
| turn-signals-with-ch-lh | Front Indicators with Coming Home | slavia | `el-turn-signals-ch-lh` (MQB-A0-IN only) | group | 09/0550 + 09/0551 | On; Off | 31347(recipe) |
| us-style-turn-lights | US-Style Front Indicators | kushaq, slavia, kylaq | `group:front-turn-lights-always-active-at-half-power-us-style` | group | 09/0550 + 09/0551 | On; Off | 31347(recipe) |

#### Not codable

| Slug | Models | Reason / search provenance |
|---|---|---|
| cornering-light-dimming-rate | virtus | unmapped in the 2026-11-03 audit: the earlier recipe (`csmqb-corner-regulation`, 0D1D) set the ECE R48 / R119 / SAE J582 regulation regime, not a fade speed. No vendor routine sets a corner-light ramp; the 0D1D parameter bytes are unlabelled, so a capture-diff is needed. |
| fog-lights-with-open-door | kylaq | no recipe mapped for platform. no-implementation: no vendor routine. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| front-pace-car-indicators-urban-joke | kushaq, slavia, virtus | no recipe mapped for platform. no-implementation: no vendor routine alternates mirror/headlight turn lamps. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| interior-light-fading | kushaq, slavia, kylaq, virtus | no recipe mapped for platform. no-implementation: no vendor routine; SmoothButtonsLight is switch backlight. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| license-plate-lights-with-hazard-lighs | kushaq, slavia, kylaq, virtus | no recipe mapped for platform. no-implementation: LicensePlate_LampsType only changes lamp type/dimming of 0569. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| lights-show-mode | kylaq, superb, taigun | no recipe mapped for platform. no-implementation: one-shot actuation (output test); no coding or routine implementation. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| mirror-turn-signals-with-ch-lh | slavia, kylaq | no recipe mapped for platform. no-implementation: MirrorLightsWithAreaView / MQB_MirrorLightsWhenFolded drive puddle lights, not mirror turn lamps. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| parking-lights-on-both-sides | slavia, kylaq | no recipe mapped for platform. no-implementation: no vendor routine. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| reading-lights-with-turn-signal | kylaq | no recipe mapped for platform. no-implementation: no vendor routine. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| rear-fog-light-warning | kylaq | no recipe mapped for platform. no-implementation: MQB_WarnAboutRearFogLightsSpeedLimit is a speed threshold (0A59 byte1), not the ignition-off warning. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| taillights-with-open-door | slavia, kylaq | no recipe mapped for platform. no-implementation: no vendor routine. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| third-brake-light-with-hazard-lights | kushaq, slavia, kylaq, virtus | no recipe mapped for platform. no-implementation: no vendor routine; 0D0E is lock/unlock feedback. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| turn-lights-when-trunk-open | slavia, kylaq | no recipe mapped for platform. no-implementation: no vendor routine. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| turn-signals-with-brake-lights | slavia, kylaq | no recipe mapped for platform. no-implementation: no vendor routine. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| turn-signals-with-fog-lights | slavia | no recipe mapped for platform. no-implementation: no vendor routine. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |
| turn-signals-with-open-door | kylaq | no recipe mapped for platform. no-implementation: no vendor routine. searched ExteriorLights.cs, FeedbackSignals.cs, InteriorLights/Other/Mirrors/Roof/Doors/Dashboard .cs, MQB_LightConfiguration*.cs and all 711 carscanner-candidates.json entries (keywords: brake/Bremse, tailgate/trunk/boot/Heck, licen/plate/Kennzeichen, hazard/Warnblink, parking/Standlicht/Parklicht, reading/Lese, fade/dimm, door/Tuer, fog/Nebel, interior/Innenlicht, mirror/Spiegel, pace/urban/show, coming/leaving). |

### service

#### Codable

| Slug | Name | Models | Recipe | Kind | Unit/DID | Settings | Password |
|---|---|---|---|---|---|---|---|
| battery-capacity | Battery Capacity | kushaq, kylaq, kodiaq, superb, taigun, virtus, tiguan | `csadapt-10133` | scalar | 19/2A31 | 44 Ah; 51 Ah; 59 Ah; 60 Ah; 61 Ah; 68 Ah; 69 Ah; 70 Ah; 72 Ah (+ free value) | 20103(unit-default) |
| battery-type | Battery Type | kushaq, kylaq, kodiaq, superb, taigun, virtus, tiguan | `csadapt-10194` | field | 19/2A31 | Standard (lead-acid); EFB; AGM | 20103(unit-default) |
| engine-oil-type | Engine Oil Type | kushaq, slavia, kylaq, virtus | `csadapt-10113` | field | 17/2248 | Regular; LongLife | 47115(unit-default) |
| inspection-service-distance | Inspection Interval (Distance) | kushaq, slavia, kylaq, virtus | `svc:inspection-service-distance` | group | 17/22A4 + 17/22D5 | 15,000 km; 20,000 km; 30,000 km; 40,000 km; 60,000 km | 47115(unit-default) |
| inspection-service-interval | Inspection Interval (Time) | kushaq, slavia, kylaq, virtus | `svc:inspection-service-interval` | group | 17/22A5 + 17/22D6 | 1 year; 2 years; 3 years; 4 years | 47115(unit-default) |
| inspection-service-reset | Inspection Reminder Reset | kushaq, slavia, kylaq, virtus | `group:reset-inspection-service-reminder` | group | 17/22A6 + 17/22A7 | Reset now | 47115(unit-default) |
| oil-change-service-distance | Oil Change Interval (Distance) | kushaq, slavia, kylaq, virtus | `svc:oil-change-service-distance` | group | 17/2246 + 17/2245 + 17/22A0 | 5,000 km; 7,500 km; 10,000 km; 15,000 km; 20,000 km; 25,000 km; 30,000 km | 47115(unit-default) |
| oil-change-service-interval | Oil Change Interval (Time) | kushaq, slavia, kylaq, virtus | `svc:oil-change-service-interval` | group | 17/2247 + 17/2293 + 17/22A1 | 6 months; 1 year; 2 years | 47115(unit-default) |
| oil-service-reset | Oil Service Reset | kushaq, slavia, kylaq, virtus | `group:reset-oil-service-reminder` | group | 17/2243 + 17/2244 + 17/2232 | Reset now | 47115(unit-default) |
| throttle-pedal-response | Accelerator Response | slavia, virtus | `csadapt-10006` | field | 44/1922 | Standard; Responsive | 19249(recipe) |

#### Not codable

| Slug | Models | Reason / search provenance |
|---|---|---|
| a-c-flap-calibration | kylaq, kodiaq, superb, taigun, tiguan | no recipe mapped for platform. routine-implementation (not expressible: contract has no routine/ecu-reset kind, so not mapped): {"src":"Climate.cs FlapAdaptations() MQBSimpleOperationWith0102StatusCheck","unit":"08","requestId":"746","responseId":"7B0","password":null,"start":"3101034D040000","cancel":"3102034D","poll":"220102"} |
| air-conditioner-compressor-activation | kodiaq, superb, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (compressor, Kompressor, B109E, first run). Only unit-08 routine is 034D flap adaptation. |
| brake-bleeding | kodiaq, superb, taigun, tiguan | no recipe mapped for platform. routine-implementation (not expressible: contract has no routine/ecu-reset kind, so not mapped): {"src":"VagBrakeBleeding.decompiled.cs BuildBrakeBleed_MQB()","unit":"03","requestId":"713","responseId":"77D","passwordVisible":true,"steps":{"First flushing cycle":"3101039E01","Bleed rear":"3101039E02","Bleed front":"3101039E03","Second flushing cycle":"3101039E04"},"cancel":"3102039E"} |
| brake-lights-test | kushaq, kylaq, superb, taigun, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (reversing, brake light, turn, Blinker, Leuchte test, output test). No unit-09 2F/31 lamp actuation exists. |
| brake-pad-replacement | kodiaq, superb, tiguan | no recipe mapped for platform. routine-implementation (not expressible: contract has no routine/ecu-reset kind, so not mapped): {"src":"ParkingBrakeRoutineMQB.decompiled.cs ctor","unit":"03","requestId":"713","responseId":"77D","options":{"Open for pad replacement":"310103A1 (finish 310203A1)","Close after pad replacement":"310103A0 (finish 310203A0)","Test parking brake":"31010410","Clear DTCs":"14FFFFFF"},"poll":"220102"} |
| door-lock-test-all | kushaq, kylaq, taigun, virtus | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (lock, Verriegelung, ZV, door actuator). Doors.cs uses 2F040503FFFFFFFF only as a post-write release of the unit-05 Easy-Open control, not a lock actuator test. |
| engine-fan-1-test | tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (fan, Luefter, radiator, cooling fan). Only 2F IOControl in corpus is 2F0405 (unit 05 Easy-Open VIP supply); unit-01 routines are 032E throttle, 030D fuel pump, 0305/053D DPF, 0311 engine automatic tests, 03FD EA288 bleeding - none drives the radiator fan. |
| engine-fan-2-test | tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (fan, Luefter, radiator, cooling fan). Only 2F IOControl in corpus is 2F0405 (unit 05 Easy-Open VIP supply); unit-01 routines are 032E throttle, 030D fuel pump, 0305/053D DPF, 0311 engine automatic tests, 03FD EA288 bleeding - none drives the radiator fan. |
| engine-fan-test | kushaq, kylaq, kodiaq, superb, taigun, virtus | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (fan, Luefter, radiator, cooling fan). Only 2F IOControl in corpus is 2F0405 (unit 05 Easy-Open VIP supply); unit-01 routines are 032E throttle, 030D fuel pump, 0305/053D DPF, 0311 engine automatic tests, 03FD EA288 bleeding - none drives the radiator fan. |
| front-left-door-lock-test | kushaq, kylaq, kodiaq, superb, taigun, virtus, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (lock, Verriegelung, ZV, door actuator). Doors.cs uses 2F040503FFFFFFFF only as a post-write release of the unit-05 Easy-Open control, not a lock actuator test. |
| front-right-door-lock-test | kushaq, kylaq, kodiaq, superb, taigun, virtus, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (lock, Verriegelung, ZV, door actuator). Doors.cs uses 2F040503FFFFFFFF only as a post-write release of the unit-05 Easy-Open control, not a lock actuator test. |
| fuel-system-priming | kylaq, kodiaq, superb, taigun, tiguan | no recipe mapped for platform. routine-implementation (not expressible: contract has no routine/ecu-reset kind, so not mapped): {"src":"FuelPumpTest.decompiled.cs ctor (codingDB_TransferFuelPumpTest)","unit":"01","requestId":"7E0","responseId":"7E8","password":"27971","start":"3101030D040000","stop":"3102030D","poll":["220102","220104"]} |
| headlight-washers-test | kushaq, slavia, kylaq, virtus | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (washer, SRA, Scheinwerferreinigung). Washer.cs only codes 0A73 intervals. |
| heater-unlock | kodiaq, superb, tiguan | no recipe mapped for platform. routine-implementation (not expressible: contract has no routine/ecu-reset kind, so not mapped): {"src":"WebastoProcedures.decompiled.cs","unit":"18","requestId":"76A","responseId":"7D4","password":null,"options":{"Disengage aux heater (recommended)":"3101047F040000 / cancel 3102047F","Unlock aux heater":"31010569040000 / cancel 31020569"}} |
| multimedia-restart | kushaq, slavia, kylaq, superb, taigun, virtus, tiguan | no recipe mapped for platform. routine-implementation (not expressible: contract has no routine/ecu-reset kind, so not mapped): {"src":"CarScannerMaui.Coding.DB.MQB.MQBMultimediaRestart.decompiled.cs ctor + OptionExecute","unit":"5F","requestId":"773","responseId":"7DD","send":["1102"],"success":"response contains 51 or 7F1178","note":"UDS ECUReset keyOffOnReset; no data written, no backup needed"} |
| rear-left-door-lock-test | kushaq, kylaq, kodiaq, superb, taigun, virtus, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (lock, Verriegelung, ZV, door actuator). Doors.cs uses 2F040503FFFFFFFF only as a post-write release of the unit-05 Easy-Open control, not a lock actuator test. |
| rear-right-door-lock-test | kushaq, kylaq, kodiaq, superb, taigun, virtus, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (lock, Verriegelung, ZV, door actuator). Doors.cs uses 2F040503FFFFFFFF only as a post-write release of the unit-05 Easy-Open control, not a lock actuator test. |
| reversing-light-test | kushaq, kylaq, superb, taigun, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (reversing, brake light, turn, Blinker, Leuchte test, output test). No unit-09 2F/31 lamp actuation exists. |
| seat-belt-tensioner-reset | kodiaq, superb, taigun | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (belt, Gurt, tensioner, B1304/B1305, unit 15). None. |
| service-soon-warning | kushaq, slavia, kylaq, virtus | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (Vorwarn, prewarn, advance warning, service soon, 22A2/22A3/2249/224C) and carscanner-candidates.json; unit-17 service DIDs present are 2232, 2243-2248, 2293, 22A0/22A1, 22A4-22A7, 22D5/22D6 only, none is a pre-warning lead time. |
| steering-angle-sensor-calibration | superb, taigun, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (steering angle, G85, Lenkwinkel, SAS, unit 44 / 03 routine). Brakes.cs only has 040A brake pressure sensor basic setting. |
| throttle-body-alignment | kushaq, slavia, kylaq, kodiaq, superb, taigun, virtus, tiguan | no recipe mapped for platform. routine-implementation (not expressible: contract has no routine/ecu-reset kind, so not mapped): {"src":"ThrottleAdaptationRoutine.decompiled.cs ctor","unit":"01","requestId":"7E0","responseId":"7E8","password":null,"start":"3101032E040000","stop":"3102032E","poll":"220102 (status) while running"} |
| tire-pressure-monitoring-system-reset | kylaq, kodiaq, superb, taigun, tiguan | no recipe mapped for platform. routine-implementation (not expressible: contract has no routine/ecu-reset kind, so not mapped): {"src":"TPMSResetRoutine.decompiled.cs ctor","unit":"03","requestId":"713","responseId":"77D","password":"20103 (hint 40168, 20103)","options":{"Reset var.1":"31010413","Reset var.2":"31010413040000"},"poll":"220102"} |
| turn-lights-test | kushaq, kylaq, superb, taigun, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (reversing, brake light, turn, Blinker, Leuchte test, output test). No unit-09 2F/31 lamp actuation exists. |
| window-calibration | kodiaq, superb, taigun, tiguan | no recipe mapped for platform. no-implementation: searched all 101 managed/*.decompiled.cs + Climate/Dashboard/Doors/ExteriorLights/FeedbackSignals.cs for 2Fxxxx IOControl, 3101xxxx routines, 11xx resets, and keywords (window, Fensterheber, normalisation, Grundeinstellung). Window recipes are coding only. |

### windows-locks

#### Codable

| Slug | Name | Models | Recipe | Kind | Unit/DID | Settings | Password |
|---|---|---|---|---|---|---|---|
| anti-theft-alarm-system | Anti-Theft Alarm | slavia | `wl-anti-theft-alarm` | group | 09/0D07\|09/0600 + 09/0D07 | On; Off | 31347(recipe) |
| auto-folding-mirrors | Auto-Fold Mirrors | kylaq, virtus | `wl-auto-folding-mirrors` | alt | 09/0A6E\|09/0D0D | Off; Fold when locked | 31347(recipe) |
| auto-lock-unlock | Auto Lock and Unlock | slavia, kylaq, virtus | `wl-auto-lock-unlock` | alt | 09/0A6A\|09/0D08 | Lock and unlock; Lock only; Unlock only; Off | 31347(recipe) |
| auto-lock-upon-exit | Walk-Away Locking | slavia, kylaq | `csmqb-mqb-05-automatically-lock-car-doors` | alt | B7/0570\|B7/0600 | On; Off | 20103(recipe) |
| auto-unlock-when-parked | Unlock When in Park | slavia, kylaq, virtus | `csmqb-lock-auto-unlock-when-selector-in-parking-nar` | alt | 09/0A6A\|09/0D08 | On; Off | 31347(recipe) |
| auto-unlock-with-ignition | Unlock When Ignition Off | kylaq, virtus | `csmqb-lock-auto-unlock` | alt | 09/0A6A\|09/0D08 | On; Off | 31347(recipe) |
| central-lock-with-ignition | Remote Locking With Engine On | kushaq, slavia, kylaq, virtus | `csmqb-enable-key-fob-while-engine-running` | alt | 09/0A65\|09/0D08 | On; Off | 31347(recipe) |
| comfort-windows | Windows by Key Remote | kushaq, slavia, kylaq, virtus | `wl-comfort-windows` | alt | 09/0A69\|09/0D0D | On; Off | 31347(recipe) |
| electronic-differential-lock-interaction | XDS Strength | slavia, kylaq, virtus | `csadapt-10000` | field | 03/0E1C | Off; Standard; Weak; Medium; Strong | 20103(recipe) |
| lock-unlock-acoustic-confirmation | Lock and Unlock Beep | kushaq, slavia, kylaq, virtus | `wl-lock-unlock-acoustic-confirmation` | alt | 09/0D0E | Lock and unlock; Lock only; Unlock only; Off | 31347(recipe) |
| lock-unlock-sound-settings | Lock and Unlock Sound | virtus | `wl-lock-unlock-sound-type` | alt | 09/0D0E | Horn; Sounder | 31347(recipe) |
| open-door-alarm | Open Door Chime | slavia, kylaq, virtus | `csadapt-10204` | field | 17/0600 | On; Off | 47115(unit-default) |
| power-windows-with-ignition-off | Windows After Ignition Off | kylaq, virtus | `csmqb-mqb-driver-electric-window-time-after-ignition-turned-off` | alt | 09/0A69\|09/0D0D | On (10 minutes); Off (+ free value) | 31347(recipe) |
| windows-closing-after-locking | Close Windows by Key Remote | slavia, kylaq, virtus | `wl-comfort-windows` | alt | 09/0A69\|09/0D0D | On; Off | 31347(recipe) |

#### Not codable

| Slug | Models | Reason / search provenance |
|---|---|---|
| comfort-windows-menu | virtus | no recipe mapped for platform. no-implementation: searched VAGCoder managed/*.cs (menu, Menuesteuerung, window, Fenster, comfort, Komfort) and carscanner-candidates.json (menu/window); only unlock/lock/mirror/acoustic MMI menus exist. RaiseAndLowerWindowsWithKeyFob sets several 0A69 bits but none is identified by the vendor as the menu bit. Not mapped. |
| one-touch-power-windows-settings | kushaq, kylaq, virtus | no recipe mapped for platform. no-implementation: searched VAGCoder managed/*.cs (window, Fenster, one touch, Tipp, Einklemm, door open, Tuer, offen, komfort) and carscanner-candidates.json (window/door/touch/auto keywords, all csadapt labels); no channel for stopping one-touch window movement when a door opens. Not mapped. |

## Earlier feature list (kept for saved backups)

These 59 features predate the catalogue and stay in the data so older backups still restore. The 34 that can be coded carry the same consumer copy as the catalogue.

| Feature id | Name | Settings |
|---|---|---|
| 80kmph-and-120kmph-speed-chime-warning | India Speed Chime | On; Off |
| acoustic-confirmation-lock-unlock-sound | Lock and Unlock Beep | On; Off |
| anti-theft-alarm | Anti-Theft Alarm | On; Off |
| auto-fold-orvms-on-long-press-of-lock-button | Auto-Fold Mirrors | On; Off |
| beats-audio | Sound Preset (Beats Audio) | Preset 1; Preset 2; Preset 3; Preset 4; Preset 5; Preset 6; Preset 7; Preset 8; Preset 9; Preset 10; Preset 11; Preset 12; Preset 13; Preset 14; Preset 15; Preset 16 |
| change-startup-logo-of-infotainment-screen | Startup Sound System Badge | None; Fender / Seat Sound; Dynaudio / Canton |
| comfort-lane-change-indicator-5-flashes | Lane Change Blinks | 2 blinks; 3 blinks; 4 blinks; 5 blinks |
| cornering-lights-via-front-fog-lights | Cornering Lights | On; Off |
| disable-automatic-door-unlock-on-key-removal | Unlock When Ignition Off | On; Off |
| disable-please-switch-on-the-lights-popup | Headlights-On Reminder | Hidden; Shown |
| display-automatic-climate-control-fan-blower-speed-in-ac-auto-mode | Fan Speed in AUTO Mode | On; Off |
| display-eco-tips | Eco Driving Screen | On; Off |
| display-offroad-menu-on-infotainment | Off-Road Screen | On; Off |
| dynamic-steering-weight | Power Steering Assistance | 100%; 80%; 60%; 40%; 20% |
| dynaudio-sound-signature-for-amplifier | Sound Preset (Dynaudio) | Preset 1; Preset 2; Preset 3; Preset 4; Preset 5; Preset 6; Preset 7; Preset 8; Preset 9; Preset 10; Preset 11; Preset 12; Preset 13; Preset 14; Preset 15; Preset 16 |
| easy-convenient-entry-and-exit-for-driver-and-passenger-seats | Easy Entry (Passenger Seat) | On; Off |
| easy-convenient-entry-and-exit-for-driver-seat | Easy Entry (Driver Seat) | On; Off |
| emergency-stop-signal-flashing-panic-braking-lights | Hazard Lights After Hard Braking | On; Off |
| engine-oil-temperature-in-mid | Oil Temperature Display | On; Off |
| engine-start-stop-button-pulsation | Pulsing Start Button | On; Off |
| enhanced-brake-assist-response-early-activation | Brake Assist Timing | Normal; Early; Late; Off |
| front-fog-lights-on-flash-along-with-headlights | Fog Lights with High Beam | On; Off |
| hill-hold-control | Hill Hold | On; Off |
| improve-torque-vectoring-with-xds-expanded-electronic-differential-lock | XDS Cornering Grip | Off; On (up to 110 kW); On (110 to 155 kW); On (162 kW and above) |
| indirect-tpms-tire-pressure-monitoring-system | Tire Pressure Monitoring | On; Off |
| instrument-cluster-needle-sweep | Needle Sweep | On; Off |
| opening-and-closing-driver-side-window-during-unlocking-and-locking-car | Driver Window by Key Remote | On; Off |
| scandinavian-rear-drl | Tail Lights with DRL | On; Off |
| seat-belt-warning-disable | Seat Belt Warning | On; Off |
| selective-door-unlocking | Selective Unlocking | All doors; Driver door only; Doors on one side |
| tear-drop-wiping | Teardrop Wipe | On; Off |
| turn-onoff-central-locking-using-remote-key-when-engine-ignition-on | Remote Locking With Engine On | On; Off |
| turning-off-drl-using-hedlamp-control-switch-or-handbrake | DRL Off With Handbrake | On; Off |
| video-in-motion-through-pen-drive | Video While Driving | Always; Up to 180 km/h |
