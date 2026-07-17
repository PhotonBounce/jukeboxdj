# JukeboxDJ → Android APK + Google Play — publishing guide

JukeboxDJ ships as a **native WebView app**: a thin Android shell
(`android/jukeboxdj/`) that bundles the whole web console (`projects/jukeboxdj/`)
into `assets/www`, served over the WebViewAssetLoader virtual https origin (the
AudioWorklet vinyl engine requires a real origin). It runs **fully offline** —
the six records are synthesized on the device.

The build is **automated in CI** — no Android Studio or local SDK needed.
[`.github/workflows/build-apk-jukeboxdj.yml`](../../.github/workflows/build-apk-jukeboxdj.yml)
builds, signs, and:

- uploads a **sideload APK** to `https://www.photon-bounce.com/jukeboxdj/jukeboxdj.apk`
  (what the microsite's **"Download the APK"** button serves), and
- attaches a signed **Play AAB** (`jukeboxdj-release.aab`) as a build artifact
  for manual upload to the Play Console.

## Monetization note (Play policy)

The web app sells a **Pro** unlock via crypto. That flow must never appear in
the Android app (Play requires Play Billing for in-app digital goods), so the
shell tags its UA `JukeboxDJApp` and the web layer **includes Pro for free**
in the app and hides all payment UI. Nothing is sold in-app; the listing can be
a plain free app. If Play Billing is wanted later, follow DJ-Photon's
`AndroidBilling` bridge pattern (`android/djapp/`).

## 1. Stable signing key (once)

Without secrets the workflow signs with an **ephemeral** key — fine for
sideloads, but Play requires the same upload key on every update:

```bash
keytool -genkeypair -v -keystore jukeboxdj-upload.keystore \
  -alias jukeboxdj -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 jukeboxdj-upload.keystore   # → JUKEBOXDJ_ANDROID_KEYSTORE_B64
```

Repo secrets: `JUKEBOXDJ_ANDROID_KEYSTORE_B64`, `JUKEBOXDJ_ANDROID_KEYSTORE_PASSWORD`,
`JUKEBOXDJ_ANDROID_KEY_ALIAS`, `JUKEBOXDJ_ANDROID_KEY_PASSWORD`.

## 2. Play Console (manual, you)

Create the app (package `com.photonbounce.jukeboxdj`), upload the
`jukeboxdj-aab` artifact from the latest workflow run, fill the listing
(screenshots live in `projects/jukeboxdj/assets/shots/`), and roll out.
Remember to bump `versionCode`/`versionName` in `app/build.gradle` per release.
