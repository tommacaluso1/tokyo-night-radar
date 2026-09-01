# Tokyo Night Radar — how it was built, and how to build it again

A field companion for a real 18-day trip (17 Sept – 4 Oct 2026): 69 places with
verified addresses, floors, opening hours and the nearest konbini; a day-by-day
plan; gyms matched to the days you're actually in that neighbourhood; 83 Japanese
phrases; 48 shop signs. One static HTML file, works offline, live GPS.

**Live:** https://tommacaluso1.github.io/tokyo-night-radar/

This document exists for a second reason: to be the blueprint for turning it into
a product that generates one of these per traveller. The most useful sections are
the ones about what *didn't* work — see [Walls we hit](#4-walls-we-hit).

---

## 1. What it actually is

A single `index.html` (~91 KB) with all trip data inlined as a JS object, plus a
service worker and a manifest. No framework, no build step at runtime, no backend,
no database, no API keys in the client.

```
site/
├── index.html            generated; markup + CSS + data + logic
├── sw.js                 offline cache
├── manifest.webmanifest  installable PWA
├── icon-512.png          rendered from HTML by headless Chrome
└── HOW-IT-WORKS.md       this file
```

Only three external dependencies at runtime, all CDN:

| Dependency | Why |
|---|---|
| Leaflet 1.9.4 | map rendering |
| OpenStreetMap tiles | the map itself (see [tiles](#tiles-dont-scale-for-free)) |
| Google Fonts | Dela Gothic One, Chakra Petch, Zen Kaku Gothic New |

Hosted on GitHub Pages. Static files on a CDN — no cold starts, no server, free.
**Vercel/Netlify would add nothing** for a workload with no serverless functions
and no build pipeline.

---

## 2. The pipeline

Five stages. Stages 1–3 are mechanical and fully automatable. Stage 4 is where the
judgment lives. Stage 5 is a git push.

```
 [1] INGEST        messy spreadsheet ──► structured place records
        │
 [2] RESOLVE       name ──► verified address, lat/lng, business status
        │
 [3] ENRICH        coords ──► nearest konbini, nearby gyms, floor, building
        │
 [4] AUTHOR        records ──► itinerary, tips, entry notes, phrases   ← the hard part
        │
 [5] GENERATE      data.json ──► index.html ──► git push ──► live
```

### Stage 1 — Ingest

Source was a four-tab `.xlsx` the user had built by hand: places, a brother's
Instagram saves, day-trip villages, coworking shortlist. Parsed with SheetJS.

Real-world input is messy and that's the normal case: inconsistent casing, place
names that are descriptions ("MUJIN FURUGI" is a shop *type*, not a shop), empty
columns, a venue in the wrong prefecture. **Design for the mess; don't assume a
clean CSV.**

### Stage 2 — Resolve

Each place name → `GOOGLE_MAPS_TEXT_SEARCH` with a locality hint appended
("Tokyo", "Shibuya"). Field mask kept tight for cost and payload:

```
places.displayName, places.formattedAddress, places.location,
places.googleMapsUri, places.businessStatus
```

Outcome: **43 of 52** resolved confidently, 9 left unresolved rather than guessed.
`businessStatus` immediately surfaced two `CLOSED_TEMPORARILY` venues and one place
that was 400 km from Tokyo.

> **Never fabricate a coordinate.** An unresolved place marked "not located" is
> honest and useful. A confidently wrong pin sends someone across a city.

Cross-check the result: one venue came back in Ochanomizu when the source sheet
said Shibuya. The source was wrong, and only the returned address revealed it.

### Stage 3 — Enrich

- **Nearest konbini** — `GOOGLE_MAPS_NEARBY_SEARCH`, `includedTypes:["convenience_store"]`,
  `maxResultCount:1`, 600 m radius, per place. 59/60 hit.
- **Gyms** — same call with `includedTypes:["gym"]` around each base neighbourhood,
  keeping rating and review count so they can be ranked honestly.
- **Floor + building** — *parsed from the address string already returned in stage 2.*
  No extra API call. This turned out to be one of the highest-value features:

```js
const FLOOR_RE = /(B\d+\s*[FＦ]?|\d+\s*[-–]\s*\d+\s*[FＦ]|\d+\s*[FＦ]|地下\s*\d*\s*階|[0-9０-９]+\s*階)/;
// "渋谷PARCO 6F" → 6F ；"…ビル 地下1階" → B1F ；full-width ２階 → 2F
```

33 of 60 addresses carried a floor. **GPS cannot resolve floors**, and Tokyo stacks
vertically — a 6F record shop and a street-level ramen bar share coordinates. The
floor badge fixes a problem no amount of positioning accuracy can.

### Stage 4 — Author

The part that isn't mechanical:

- **Itinerary sequencing.** Cluster by geography, respect fixed commitments, work
  days and the venue's own hours. Requires reasoning about a *conflict*: the trip's
  headline event ran across a work day, and only checking real event dates surfaced it.
- **Practical tips.** "Tax-free is a separate counter on another floor", "most Jimbōchō
  shops close Sundays", "all-you-can-eat runs a 90-minute clock". Generic advice is
  worthless; tips tied to a specific venue and day are what people actually use.
- **Entry notes.** Derived from floor type where no specific knowledge exists
  (basement → "street-level stairwell, easy to walk past"), specific where it does.
- **Phrases and signs.** Grouped by the kind of place you're standing in, not by
  grammar. A phrasebook sorted by venue beats one sorted by verb tense.

### Stage 5 — Generate and deploy

`build-data.mjs` writes `app-data.json`; `build-web.mjs` inlines it into a template
literal and writes `site/index.html`; `git push` to a Pages repo. Deploy is ~60–90 s.

Every build runs a self-check before deploying — see [Verify by counting](#5-verify-by-counting).

---

## 3. How the app works at runtime

### Data shape

One frozen object. Short keys because it's inlined into the page:

```js
{ n:name, la:lat, lo:lng, c:category, p:priority(0|1|2), d:planned day,
  o:day order, a:area, w:why (the user's own words), t:tip, e:entry note,
  k:"7-Eleven · 83m", f:"B1F", h:[open,close], we:weekendOnly, x:warning }
```

`h:[18,26]` means 18:00–02:00. **Closing hours past midnight are stored as >24** so
comparison stays arithmetic instead of special-cased:

```js
const cur = h + m/60;
return b <= 24 ? (cur >= a && cur < b)      // normal
                : (cur >= a || cur < b-24);  // wraps past midnight
```

### The lit/dark mechanic

The clock is Tokyo's, not the device's:

```js
new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Tokyo",hour:"2-digit",
  minute:"2-digit",weekday:"short",hour12:false})
```

Each place's name renders as a neon sign in its category colour when open and goes
dark and unlit when closed. Re-evaluated every 60 s. The page background also shifts
through seven states by Tokyo hour (夕暮れ dusk → 深夜 late → 丑三つ dead of night).

Hours are **typical by venue type**, not verified per venue, and the UI says so.
Presenting a guess as fact is worse than presenting it as a guess.

### Location

`watchPosition` with `enableHighAccuracy:true, maximumAge:0`. Phones hand you a
coarse wifi/cell fix within a second and a satellite fix 10–30 s later, then
sometimes fall back. Three filters:

1. reject a fix suddenly **2.5× worse** than a good recent one (the wifi fallback)
2. reject jumps implying **> 150 km/h**
3. never accept a cached position

Accuracy is graded and shown honestly: ≤12 m satellite, ≤35 m good, ≤120 m
wifi-grade, worse is coarse. The ring around the dot is real accuracy, colour-coded.

### Offline

Service worker, two caches:

- **shell** — precached: page, Leaflet, fonts, icon, manifest
- **tiles** — cache-first, capped at 400 entries, oldest quarter trimmed when full

Navigation is network-first with a cached fallback, so the app always opens.

---

## 4. Walls we hit

The most transferable part of this document.

### Google gives you no write access to consumer maps

- **My Maps has no public API.** None. You cannot create, edit or populate a custom
  map programmatically. The only route is a human in a browser.
- **Saved Lists have no API and no bulk import.** The "influencer map" format is
  strictly one place at a time, by hand. This is why those products are 25–40 places,
  and why polished ones are actually built on Rexby/Proxi/Thatch — *not* Google.
- **The Sheets API cannot write to `.xlsx`** in Drive. Convert to a native Sheet
  (`GOOGLEDRIVE_COPY_FILE_ADVANCED` with `mimeType: application/vnd.google-apps.spreadsheet`)
  or every write fails.
- **My Maps *can* import a Google Sheet** with lat/long columns, and style by a
  category column. That was the working route into a custom map.

### Sandboxed iframes cannot use geolocation

The single biggest architectural constraint. A page embedded in a host that doesn't
delegate the permission gets no location — the browser never even prompts:

```js
document.featurePolicy.allowsFeature('geolocation')   // false → nothing you can do
```

Check that value before designing around location. Deploying to a normal HTTPS
origin was the fix, and it also removed the CSP that blocked map tiles. **If the
product needs GPS or third-party tiles, it must be a real deployment, not an embed.**

### Tiles don't scale for free

CARTO's keyless dark tiles now return images stamped **"API KEY REQUIRED"**. We
switched to OpenStreetMap with a CSS filter on the tile pane only:

```css
.leaflet-tile-pane{filter:invert(1) hue-rotate(185deg) brightness(.78) contrast(1.18) saturate(.62)}
```

Free, no key, zoom 19, and the filter is scoped so markers stay untouched.

> **For a product, this must change.** OSM's tile policy covers modest use, not a
> commercial service. Budget for Mapbox, MapTiler or self-hosted Protomaps.

### Opaque responses break naive caching

Leaflet loads tiles as plain `<img>`, so a service worker sees **opaque** responses
with `status 0` and `ok === false`. A check of `if (res.ok)` caches **zero tiles** and
you only discover it with no signal:

```js
if (net.ok || net.type === "opaque") { await cache.put(req, net.clone()); }
```

### API quotas and toolkit versions

- Places **Text Search** and **Geocoding** have **separate quotas**. When text search
  was exhausted, geocoding still worked — that's a viable fallback path.
- Composio tool calls need the **toolkit's own version**, not another toolkit's.
  Passing the Sheets version to a Maps tool fails silently-ish. Fetch it:
  `GET /api/v3/toolkits/{slug}` → `meta.version`.
- Composio's Drive upload **renames files** to `file_ts<timestamp>`. If you then search
  for your original filename, you find nothing and conclude the upload failed.

### Two JavaScript traps that cost real time

```js
CATS.forEach(mkchip);        // passes (value, INDEX, array) → index became a CSS class
CATS.forEach(c => mkchip(c));// what you meant
```

And inside a template literal, `\s` collapses to `s`, so a regex written in generated
code emits as `/s*/s*/g` — broken JavaScript, whole script fails to parse. Avoid
regex literals in generated code, or escape every backslash.

---

## 5. Verify by counting

Every build asserts on the output rather than trusting it. This caught the chip class
bug, the broken regex, the empty tile cache, and a whole missing data column:

```js
// does the generated script even parse?
try { new Function(js); } catch (e) { fail(e.message); }

// does every filter show as many map pins as list rows?
for (const chip of chips) { chip.click(); assert(rows === pins && rows > 0); }

// did the data actually arrive?
assert(places.filter(p => p.f).length === 33);   // floors
assert(places.filter(p => p.k).length === 59);   // konbini
```

The best catch: searching "vinyl" returned **1** result when the trip had seven vinyl
shops. Cause — the source spreadsheet's *why* column had never been carried through
the pipeline, so 51 places had silently lost the user's own reason for choosing them.
Nothing looked broken. Only the count was wrong.

> **Count what should be there. A feature that renders is not a feature that works.**

---

## 6. Generalising this into a product

### Input schema

```jsonc
{
  "destination": "Tokyo, Japan",
  "dates": { "arrive": "2026-09-17", "depart": "2026-10-04" },
  "travellers": [{ "name": "Tom" }, { "name": "Bro" }],
  "workDays": ["2026-09-21", "2026-09-22", "2026-09-28", "2026-09-29"],
  "base": "Shibuya",
  "interests": ["records", "anime", "techno", "thrift", "gaming"],
  "fixedEvents": [{ "name": "Tokyo Game Show", "date": "2026-09-19" }],
  "wants": { "gym": "2-3x per week", "dayTrips": 2, "nightlife": "high" },
  "constraints": { "tattoos": true, "budget": "mid", "dietary": null },
  "places": "<csv | xlsx | list of names | instagram saves>"
}
```

### What automates cleanly

| Stage | Automatable | Notes |
|---|---|---|
| Ingest | ✅ | accept CSV/XLSX/plain list |
| Resolve | ✅ | Places Text Search + business status |
| Enrich | ✅ | konbini, gyms, floors, hours |
| Categorise | ✅ | LLM from name + Places `types` |
| Itinerary | ⚠️ | LLM, but needs the constraint checks below |
| Tips / entry notes | ⚠️ | LLM; must be grounded in fetched data, not invented |
| Phrases / signs | ✅ | per-language pack, reusable across every trip |
| Generate + deploy | ✅ | template + git push, or any static host |

### Constraint checks worth building in

These are what made the itinerary trustworthy, and each caught a real problem:

1. **Event dates vs work days** — the headline event's public days overlapped a work day.
2. **`businessStatus`** — flag temporarily-closed before someone travels across town.
3. **Distance sanity** — anything > 100 km from base is a day trip, not an afternoon.
4. **Opening hours vs planned slot** — don't schedule a bar at 11:00.
5. **Weekend-only venues** — must land on a weekend.
6. **Closing days** — Wednesdays, Sundays; a shut shop ruins a planned day.

### Per-trip cost

Roughly 70 text searches + 70 nearby searches + a handful of geocodes. At Google's
Places pricing that is a few dollars per trip — small next to what people pay for a
guide, but not free. Cache aggressively by destination: **konbini near Shibuya Parco
is the same answer for every customer**, so enrichment should be a shared per-city
cache, not per-user.

### Reusable vs bespoke

**Reusable across every trip:** the whole pipeline, the app shell, the lit/dark
mechanic, GPS handling, offline layer, the constraint checks, and the phrase/sign
packs per language.

**Bespoke per trip:** the place list, the itinerary narrative, and the per-venue
tips. That is exactly the split a product wants — the expensive engineering is
built once, and what varies is data plus one authoring pass.

### The honest limitation

The thing that made this good was not the pipeline. It was **grounding every claim
in fetched data and refusing to invent the rest.** 9 places stayed marked "not
located". Hours are labelled as typical, not verified. Two matches are flagged
uncertain. A generator that fills those gaps with plausible-sounding text produces
something that looks better and is worth less — and the traveller finds out at a
locked door, 6,000 miles from home.

---

*Built with Claude Code. Data: Google Places API. Map: Leaflet + OpenStreetMap.*
