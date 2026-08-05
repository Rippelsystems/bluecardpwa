# Blue Card Digital System — PWA

Progressive Web App for RLL (and future XRGL40 / GRN40 / Fitment) build cards.

## Setup

### 1. Supabase
Open `js/supabase.js` and replace:
```
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';
```
Use TEST project first: `wtkbsvopuvtxiprjtqqx`

### 2. GitHub Pages
1. Push this folder to a GitHub repo
2. Go to repo Settings → Pages → Source: main branch / root
3. Your URL will be: `https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/`

### 3. Supabase Tables
Run in TEST first. Tables needed:
- `weapon_builds` — master record per unit
- `weapon_build_checks` — check results
- `weapon_serial_photos` — photo refs
- `weapon_signoffs` — sign-off records
- `assemblers` — operator registry

### 4. Android Tablets
Open the GitHub Pages URL in Chrome → menu → "Add to Home Screen"

---

## File Structure
```
index.html          — all screens (single-page app)
manifest.json       — PWA manifest
sw.js               — service worker (offline support)
css/style.css       — all styles
js/app.js           — app logic, form handling, routing
js/supabase.js      — Supabase client + helpers
```

## Card Types
- [x] RLL — built
- [ ] XRGL40 — next (same base, add Sight Movement + Sight Serial fields)
- [ ] GRN40 — 21 sub-assembly stages
- [ ] Fitment Record — awaiting zeroing docs from Michiel

## Blocking Items (from handover)
- Reviewed Blue Card PDF back from Duncan, Michiel, Emile, Lodewikus
- Serial number formats from Michiel (for format validation)
- Zeroing doc + Sight QC doc for Fitment Record
- IT WiFi confirmation for external URLs
