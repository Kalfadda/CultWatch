# 🍔 CultWatch — Launch-Day Situation Room

A sleek, real-time desktop dashboard for **Happy's Humble Burger Cult** (Steam
App ID `3453910`). Built for the dev team to watch the launch unfold live —
concurrent players, Steam reviews, Twitch streams, community chatter, news, and
video coverage — all on one screen that refreshes itself.

![radar](build/icon.png)

---

## Quick start

```bash
npm install      # installs Electron (downloads the runtime the first time)
npm start        # launches the app
```

That's it. **Steam data works with zero configuration** — live players, review
score, store details, and official news all light up immediately. The countdown
clock ticks down to `Jul 16, 2026`, then flips to a live **day-N** counter.

To unlock the remaining sources, open **⚙ Settings** (top-right) and paste in
whatever keys you have. Everything degrades gracefully — a source with no key
just shows a friendly "add your key" note instead of breaking the board.

Verify the data layer at any time without opening the GUI:

```bash
npm run check    # hits the live endpoints and prints a health report
```

---

## What it tracks

| Panel | Source | Needs a key? |
|-------|--------|--------------|
| **Live concurrent players** + rolling chart | Steam `GetNumberOfCurrentPlayers` | No |
| **Session & all-time peak** | derived, persisted to disk | No |
| **Review score, positive/negative, recent reviews** | Steam `appreviews` | No |
| **Store details, price, genres, launch date** | Steam `appdetails` | No |
| **Official news & announcements** | Steam `GetNewsForApp` | No |
| **Reddit mentions** | Reddit search JSON | No |
| **Bluesky posts** | Bluesky public AppView | No |
| **Live Twitch streams** + viewer totals | Twitch Helix | Client ID + Secret |
| **Recent YouTube videos** | YouTube Data API v3 | API key |
| **X / Twitter mentions** | X API v2 recent search | Bearer token (paid) |

The **top-bar status dots** show the health of every source at a glance (green =
ok, red = erroring, hollow = disabled). Hover any dot for detail and latency.

---

## Getting the optional keys

- **Steam Web API key** *(optional)* — <https://steamcommunity.com/dev/apikey>.
  Core Steam data doesn't need it; it's there for reliability/rate headroom.
- **Twitch** — create an app at <https://dev.twitch.tv/console/apps> to get a
  **Client ID** and **Client Secret**. CultWatch mints its own app token.
  The "Twitch category / game name" in Settings must exactly match Twitch's
  category once it exists.
- **YouTube** — in Google Cloud Console, enable **YouTube Data API v3** and
  create an API key.
- **X / Twitter** — needs a paid API tier with recent-search access. Optional;
  **Bluesky covers the free social angle.**

Keys are stored locally in your OS user-data directory (see below) and are
never committed to the repo or sent anywhere except the respective API.

---

## Settings

Open with the **⚙** button or `Ctrl/⌘ + ,`.

- **Target game** — App ID, display name, launch date/time (drives the
  countdown), and refresh interval (min 15s, default 60s).
- **Discovery keywords** — terms used for Reddit / Bluesky / X / YouTube search.
- **Credentials** — the optional keys above.
- **Active sources** — toggle any source on/off.

Saving refreshes all sources immediately.

Keyboard: `Ctrl/⌘ + R` refresh · `Ctrl/⌘ + ,` settings · `Esc` close.

---

## Building installers

```bash
npm run dist          # build for the current OS
npm run dist:win      # Windows  (NSIS installer)
npm run dist:mac      # macOS    (dmg)
npm run dist:linux    # Linux    (AppImage)
```

Output lands in `release/`. The app icon is committed at `build/icon.png`
(regenerate with `node scripts/gen-icon.js`).

---

## Architecture

```
electron/
  main.js            Electron main process: window, IPC, poll loop, external links
  preload.js         Secure contextBridge — the only surface the UI can call
  config.js          Zero-dep JSON settings + player-history persistence
  poller.js          Fetches every source in parallel, tolerates failures,
                     builds one snapshot with a per-source status map
  services/
    http.js          fetch wrapper (User-Agent, timeout, JSON helpers)
    steam.js         appdetails · players · reviews · news
    reddit.js  bluesky.js  twitch.js  youtube.js  x.js
renderer/
  index.html         layout
  styles.css         the "situation room" design system (dark, amber accent)
  app.js             rendering, hand-rolled SVG player chart + review ring,
                     countdown, settings drawer, feeds
scripts/
  selftest.js        headless data-layer smoke test (npm run check)
  gen-icon.js        dependency-free PNG icon generator
```

**Why the main process does the fetching:** browsers block cross-origin calls to
the Steam store API. Electron's main process is Node, so it fetches freely and
hands finished snapshots to the UI over IPC. The renderer runs under a strict
CSP with no Node access.

Player-count samples are appended to a rolling history file so the chart
survives restarts:

- **Config:** `<userData>/cultwatch-config.json`
- **History:** `<userData>/cultwatch-history.json`

`<userData>` is `%APPDATA%/CultWatch` (Windows), `~/Library/Application
Support/CultWatch` (macOS), or `~/.config/CultWatch` (Linux).

---

## Troubleshooting

- **Reddit / Bluesky show an error** — these APIs block some datacenter/VPN IP
  ranges. From a normal residential desktop connection they work out of the box.
  `npm run check` will report this too.
- **Twitch says "no category yet"** — Twitch only creates the game category once
  streamers tag it (usually right around launch). It'll populate automatically.
- **Players stay blank before launch** — expected. Steam has no live player data
  until the game is out; the endpoint returns "no data yet" and the board waits.
- **A source dot is red** — hover it for the exact error and response time.
