# PhotonBounce — repo rules for Claude

## QA + proof rule (applies to EVERY change, all projects)

1. **5 clean QA cycles before shipping.** One cycle = the project's full QA
   gate (for `projects/observer`: all 13 suites in `qa/observer/`, run with
   `cd qa/observer` and `PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`)
   **plus one distinct adversarial probe** that wasn't run before. Any genuine
   app bug found → fix it, add a regression test, and restart the clean count
   at zero. Probe bugs (test artifacts) don't reset the count, but must be
   verified against real app behavior before being dismissed.
2. **Local green is not shipped.** After merge + deploy, verify the LIVE site
   by dispatching `.github/workflows/live-qa-observer.yml` (curl freshness
   checks + Playwright E2E against https://photon-bounce.com/observer/ with
   screenshot artifacts). A release counts as done only when live QA is clean
   — run it until 3 consecutive clean live runs.
3. **The APK is its own environment — test it.** The Android shell serves the
   bundled app via WebViewAssetLoader (https://appassets.androidplatform.net);
   a plain file:// load CANNOT run this ES-module app (CORS-dead buttons, the
   v1.3.0 field failure). `qa/observer/apk-env.mjs` enforces the shell contract
   and runs every experiment in APK-equivalent conditions (no backend, no SW,
   no billing bridge) — it must stay in the gate. Never register the service
   worker on the appassets origin (worker fetches bypass the asset loader).
4. **Screenshot proof for every user request.** Each delivered feature/fix is
   supported with screen captures showcasing the accomplished work (from live
   QA artifacts or local Playwright shots), sent to the user with full file
   paths / URLs.

## Cache poisoning — hard-won lessons (do not regress)

- The host runs LiteSpeed with aggressive server-side caching (it has cached
  404s and day-old JS). Never serve app JS/CSS with `Cache-Control: public`;
  `projects/observer/.htaccess` disables LiteSpeed page cache for the app and
  serves JS/CSS `private` — keep it that way.
- The service worker must precache with `cache: "reload"` requests and bump
  its `CACHE` version on every release; `index.html` registers with
  `updateViaCache: "none"`, forces `reg.update()`, and reloads once on
  `controllerchange` so stale clients self-heal on first visit.

## Deploy facts

- `deploy.yml` mirrors `projects/observer/` → `/public_html/observer/` on push
  to main; `qa/**` and `android/**` do not deploy.
- `build-apk-observer.yml` builds + signs APK/AAB (secrets `OBSERVER_*`,
  alias `intentmonitor`), publishes the APK to
  `/public_html/observer/intent-monitor.apk`, uploads AAB + R8 mapping
  artifacts for Play Console.
- Android WebView shell bundles the web app at build time — users on an old
  APK see the old app until they install the new APK / Play update.
- The user handles Play Console uploads; everything else is automated.

## Branch protocol

- Develop on the session's designated `claude/*` branch; after each
  squash-merge, reset it onto `origin/main` (`git checkout -B <branch>
  origin/main` + `push --force-with-lease`) — never stack on merged history.
