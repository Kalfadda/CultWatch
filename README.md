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
| **Reddit mentions** | Reddit OAuth search | Client ID (free) |
| **Bluesky posts** | Bluesky public AppView | No |
| **Live Twitch streams** + viewer totals | Twitch Helix | Client ID + Secret |
| **Recent YouTube videos** | YouTube Data API v3 | API key |
| **X / Twitter mentions** | X API v2 recent search | Bearer token (paid) |

The **top-bar status dots** show the health of every source at a glance (green =
ok, red = erroring, hollow = disabled). Hover any dot for detail and latency.

---

## Launch-day alerts 🔔

CultWatch watches the numbers so you don't have to stare at the screen. The
**🔔 bell** in the top bar is your alert center; each event also fires a native
**desktop notification** (click it to jump to the relevant page) and a subtle
chime. Mute both with one click, or send a **test** notification to confirm
they're wired up.

Alerts fire for:

- **🚀 We're live** — the moment Steam first reports live players.
- **🎉 Player milestones** — 100, 250, 500, 1K, 2.5K, 5K, 10K, … concurrent.
- **📈 New peak** — a fresh all-time concurrent high (throttled).
- **⚡ Surge / 🔻 drop** — a sharp % swing between samples. A surge often means a
  streamer just went live; a drop can flag an outage or crash spike (critical).
- **⭐ First review** and **👍/👎 new reviews** — with the review text inline, so
  you can respond fast. Optionally **only negative** reviews.
- **📊 Rating band change** — e.g. "Very Positive" → "Mostly Positive".
- **📺 Big Twitch streams** — someone above your viewer threshold picks up the
  game.

Tune every toggle and threshold (spike %, minimum players, big-stream viewers)
under **⚙ Settings → Launch Alerts**. Alert bookkeeping is de-duplicated and
persisted, so you won't get spammed with the same event or the whole review
backlog after a restart. Logic is unit-tested — run `npm run test:alerts`.

---

## Getting the optional keys

- **Steam Web API key** *(optional)* — <https://steamcommunity.com/dev/apikey>.
  Core Steam data doesn't need it; it's there for reliability/rate headroom.
- **Reddit Client ID** — Reddit locked down unauthenticated API access under its
  Responsible Builder Policy, so a free app token is now required. Create one at
  <https://www.reddit.com/prefs/apps> → **create app** → type **installed app**
  → redirect URI `http://localhost` → paste the ID shown *under the app name*.
  Client ID alone is enough (no secret, no approval queue at our ~1 req/min).
  If you registered a "web app" instead, also paste its secret.
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
  alerts.js          Pure alert engine: diffs snapshots -> notifications
                     (launch, milestones, spikes, reviews, big streams)
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
  selftest.js        headless data-layer smoke test (live endpoints)
  test-alerts.js     alert-engine unit tests (npm run test:alerts)
  gen-icon.js        dependency-free PNG icon generator
                     (npm run check runs the alert tests + the smoke test)
```

**Why the main process does the fetching:** browsers block cross-origin calls to
the Steam store API. Electron's main process is Node, so it fetches freely and
hands finished snapshots to the UI over IPC. The renderer runs under a strict
CSP with no Node access.

Player-count samples are appended to a rolling history file so the chart
survives restarts:

- **Config:** `<userData>/cultwatch-config.json`
- **History:** `<userData>/cultwatch-history.json`
- **Alert state:** `<userData>/cultwatch-alertstate.json` (de-dup bookkeeping)

`<userData>` is `%APPDATA%/CultWatch` (Windows), `~/Library/Application
Support/CultWatch` (macOS), or `~/.config/CultWatch` (Linux).

---

## Troubleshooting

- **Reddit shows an error** — Reddit now requires an OAuth token even for
  reads (Responsible Builder Policy). Add a free **Client ID** in Settings (see
  above). Without it, CultWatch tries the public RSS fallback, which Reddit also
  rate-limits, so a Client ID is strongly recommended.
- **Bluesky shows an error** — its public API blocks some datacenter/VPN IP
  ranges. From a normal residential desktop connection it works out of the box.
- **Twitch says "no category yet"** — Twitch only creates the game category once
  streamers tag it (usually right around launch). It'll populate automatically.
- **Players stay blank before launch** — expected. Steam has no live player data
  until the game is out; the endpoint returns "no data yet" and the board waits.
- **A source dot is red** — hover it for the exact error and response time.
