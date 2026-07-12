# JukeboxDJ

A real twin-turntable DJ rig that runs in the browser — two working turntables
you can scratch, a full mixer, a jukebox of tracks, AI Auto-Mix, scratch-FX
pads, and one-tap recording. No install, no account, works offline. Also ships
as an Android app (WebView shell).

## What's here
- `projects/jukeboxdj/` — the web app (Web Audio engine, AudioWorklet vinyl
  physics, mixer, PWA service worker) and the landing microsite.
- `android/jukeboxdj/` — the Android WebView shell + Play listing assets.
- `qa/jukeboxdj/` — Playwright QA suites, adversarial probes, and the
  screenshot/asset generators.
- `.github/workflows/` — deploy (FTP), Android APK/AAB build, live QA.

## Highlights
- **True vinyl scratching** — sample-accurate, driven by an AudioWorklet with
  motor inertia and hand friction.
- **AI Auto-Mix** — 10 hands-on techniques + 10 autonomous "AI DJ" modes.
- **Scratch-FX pads** — 10 synthesized vinyl hits (keys 1–0).
- **Beat-reactive mixer** — colour-shifting "water" with musical notes swimming
  to the beat.
- **Record your set** — capture the master bus to a file. Pro tier unlocks
  unlimited high-bitrate recording (bundled free in the Android app).

## Run the app locally
Serve `projects/jukeboxdj/` over HTTP (the AudioWorklet needs a real origin):
`cd qa/jukeboxdj && node serve.mjs` then open the printed URL + `/app.html`.

## QA
`cd qa/jukeboxdj && npm i` then run the suites with a Chromium binary, e.g.
`PW_CHROMIUM=<chrome> node ui.mjs` (also smoke, audio, landing, pro, automix,
probe1–7).

## Deploy notes
`deploy.yml` mirrors `projects/**` to the host over FTP. To use it here, add
the repo's `FTP_SERVER` / `FTP_USERNAME` / `FTP_PASSWORD` secrets; the Android
build needs the `JUKEBOXDJ_ANDROID_*` signing secrets.
