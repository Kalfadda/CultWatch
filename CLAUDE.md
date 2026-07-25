# CultWatch — working notes

Live launch-day situation room for **Happy's Humble Burger Cult** (Steam appId `3453910`,
Scythe Dev Team, published by tinyBuild). Electron on the desktop, Capacitor on Android,
**one shared codebase**.

## Shape of the thing

```
electron/            data layer + Electron shell  (CommonJS)
  services/          one file per source; ALL keyless-capable, all use global fetch
  poller.js          fetches every enabled source, derives finished numbers
  config.js          DEFAULTS + Store (config, alert state); composes series/reviews/events
  history.js         tiered player series (fine 48h / medium 30d / daily forever)
  alerts.js          PURE — evaluate(prev, next, state, cfg, now); caller persists
renderer/            plain HTML/CSS/JS, no framework, no bundler
  app.js             LIVE board, settings drawer, view switching, boot()
  trends.js          TRENDS board        tinybuild.js  TINYBUILD board
mobile/
  platform/          THE ONLY hand-written mobile source (bootstrap, atomic, http, mobile.css)
  www/               GENERATED — gitignored, never edit
  android/           Capacitor Gradle project (+ ApkDownload.java native plugin)
scripts/             tests, selftest, mobile bundler, layout checker
docs/superpowers/    specs/ and plans/
```

## Non-negotiables

- **Zero runtime dependencies** beyond `electron-updater`. No bundler, no framework, no test
  framework — tests are plain `node scripts/test-*.js` with a local `ok(name, cond)`.
- **Services never reject.** A failing source degrades its own row only; it must never redden a
  whole panel or silently shrink a comparison set.
- **The renderer computes no analysis.** Finished numbers arrive from the main process.
- **Say what is actually known.** Gaps in history render as gaps, partial days are marked
  partial, unavailable rows render dim rather than vanishing. Never imply a complete record.
- Comments explain *why*, not *what*, matching the density of surrounding code.

## Commands

```bash
npm run check          # unit suites + live self-test — must be green before any release
npm start / npm run dev
npm run release        # desktop → GitHub (electron-builder --publish always)
npm run mobile:apk     # SIGNED RELEASE apk (this is the publishable one)
npm run mobile:apk:debug   # debug apk — for the layout checker ONLY, never publish
npm run mobile:layout  # measures the real DOM on a connected device (needs the DEBUG build)
```

## Releasing (both platforms, every feature)

Kaleb's standing rule: **every feature ships to PC *and* Android in the same session, both
auto-updating.** A merged commit reaches nobody.

1. Bump `package.json` **and** `mobile/android/app/build.gradle` (`versionName` +
   `versionCode`, e.g. 1.4.2 → 10402).
2. `npm run check`.
3. `npm run release` → desktop installer + `latest.yml`.
4. `npm run mobile:apk`, verify, then `gh release upload vX.Y.Z <apk> --clobber`.
5. `git push`.

**Verify every APK before publishing** — a debug build was published once:

```bash
apksigner verify app-release.apk                      # must verify
aapt2 dump xmltree --file AndroidManifest.xml <apk> | grep -i debuggable   # must be empty
```

A debug APK is `debuggable=true` (anyone can `run-as` and read user data) and signed with the
SDK's universal "Android Debug" key. Publishing one also **permanently strands** its users:
Android identifies an app by signature, so a later release-signed build fails with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` and they must uninstall, losing local history.

Release keystore: `C:/Users/Kaleb/android-tools/cultwatch-release.jks`, credentials in the
gitignored `mobile/android/keystore.properties`. **Losing it means no Android install can ever
be updated again.**

## Android specifics

The port is small because none of the intelligence was ever Node-bound. `scripts/build-mobile.js`
bundles `electron/` and swaps three modules:

| module | desktop | Android |
|---|---|---|
| `./atomic` | `fs` | `localStorage` — kept **synchronous**, which is why config/history/reviews/events need no changes |
| `./services/http` | Node fetch | `CapacitorHttp` — Steam sends no CORS header, so a WebView fetch is blocked before the body is readable |
| `fs` / `path` | Node built-ins | shims (paths become storage keys) |

`mobile/platform/bootstrap.js` replaces `main.js` + `preload.js` and exposes the identical
`window.cultwatch` surface, so the three view scripts are copied over untouched.

### Four traps that each shipped a bug

1. **Global scope.** Renderer scripts are classic scripts sharing one lexical scope. A top-level
   `let` in bootstrap matching one in `app.js` is a SyntaxError that stops app.js executing
   *entirely* — dead UI, healthy data layer. Bootstrap declares nothing global but
   `window.cultwatch`; `scripts/test-mobile.js` enforces it.
2. **Layout.** Desktop CSS assumes ~1400px. The ⚙ button went off-screen at 344px, and panel
   tabs were clipped by `overflow-x: hidden` — invisible in a screenshot. Run
   `npm run mobile:layout`.
3. **`position: fixed` inside `.topbar`.** Its `backdrop-filter` creates a containing block, so
   fixed descendants anchor to the topbar, not the viewport. Dropped on mobile.
4. **Downloads.** Never route a file download through `Browser.open()` (a Chrome Custom Tab):
   the transfer is owned by a session that dies with the tab, leaving the file flagged MediaStore
   `IS_PENDING` — fully downloaded, invisible to the installer, "Download pending…" forever.
   Use the `ApkDownload` plugin (Android `DownloadManager`). Its ids cross the bridge as **strings**,
   because a long arrives as `Integer` and `PluginCall.getLong()` then returns null.

## Verification

**Verifying the data layer is not verifying the app.** Traps 1 and 2 both passed every data-layer
check while the app was unusable. For anything user-facing, confirm the UI renders and the
controls respond — `npm run mobile:layout` for geometry, a screenshot or CDP for behaviour.

Peer/cohort App IDs and any live figures quoted in docs were verified against the real API at the
time of writing; re-verify rather than trusting them.
