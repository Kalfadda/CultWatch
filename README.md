# 🍔 CultWatch — Launch-Day Situation Room

A sleek, real-time desktop dashboard for **Happy's Humble Burger Cult** (Steam
App ID `3453910`). Built for the dev team to watch the launch unfold live —
concurrent players, Steam reviews, Twitch streams, community chatter, news, and
video coverage — all on one screen that refreshes itself.

![radar](build/icon.png)

---

## Easiest way (for non-technical teammates)

You don't need the terminal at all. Get the CultWatch folder (a zip is fine),
then:

- **Windows** — double-click **`CultWatch.bat`**
- **macOS** — double-click **`CultWatch.command`**

On the **first** run it installs everything automatically (and, on Windows, will
even offer to install Node.js for you). Every run after that just opens the app.
That's the whole process — no installer, no commands.

> First launch downloads the app runtime, so it takes a few minutes. After that
> it opens in seconds. A black terminal window stays open while the app runs —
> minimize it; closing it closes CultWatch.

**To update (no terminal), if you got the folder via `git clone`:** double-click
**`CultWatch-Update.bat`** (Windows) or **`CultWatch-Update.command`** (macOS).
It pulls the latest version, installs anything new, and relaunches. (Didn't
clone with git? Just replace the folder with a fresh copy.)

## Quick start (from the terminal)

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
| **Web / press coverage** | Google News RSS (whole-web sweep) | No |
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
- **Discovery keywords** — terms used for Reddit / Bluesky / X / YouTube / Web
  search. Ships with both the current name and the original **"Happy's Humble
  Burgatory"** so older chatter is caught too. Add or remove terms freely.
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

## Auto-update

Installed builds update themselves via **electron-updater + GitHub Releases** —
no more re-sending folders. On launch (and every 6 hours) CultWatch checks the
repo's Releases, downloads a newer version in the background, and shows a green
**"Update ready — Restart"** pill in the top bar; clicking it installs and
relaunches. There's also **⚙ Settings → ⬇ Updates** to check on demand.

**Publishing a new version** (maintainer):

1. Bump `version` in `package.json`.
2. Set a GitHub token so electron-builder can upload the release:
   `set GH_TOKEN=<your token>` (Windows) / `export GH_TOKEN=…` (mac/Linux).
3. `npm run release` — builds and publishes to the repo's Releases.

Every installed copy picks it up automatically within 6 hours (or on next
launch). Notes:

- **Private repo:** because `kalfadda/cultwatch` is private, each installed copy
  needs a token to read release assets — set a `GH_TOKEN` env var on the machine,
  or publish the releases to a **public** repo (change `build.publish.repo`).
  Public releases = zero-config updates for everyone; that's the simplest path
  for non-technical teammates.
- **macOS** auto-update requires a code-signed app; unsigned mac builds won't
  self-update (Windows/Linux are fine unsigned).
- Running from source (`npm start` or the `.bat`/`.command`) has no update feed.
  If the folder was `git clone`d, update it with one click via
  **`CultWatch-Update.bat`** / **`CultWatch-Update.command`** (runs `git pull` +
  `npm install` + launch). Otherwise re-send the folder.

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
    web.js           whole-web news sweep (Google News RSS, keyless)
    reddit.js  bluesky.js  twitch.js  youtube.js  x.js
CultWatch.bat / .command          double-click launcher (install + run)
CultWatch-Update.bat / .command   double-click updater (git pull + install + run)
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
