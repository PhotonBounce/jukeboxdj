# JukeboxDJ — Google Play store listing

Copy-paste fields for Play Console → *Main store listing*. Character limits noted.
All graphics referenced live in this folder unless noted.

- **Package name:** `com.photonbounce.jukeboxdj`
- **Category:** Music & Audio
- **Contains ads:** No
- **In-app purchases:** No — Pro is included free in the Android app (the web
  build sells Pro via crypto; the app never sells digital goods, so no Play
  Billing is required and the app can list as free).

## App name (max 30)
```
JukeboxDJ — Turntables & Mixer
```
*(30 chars. Fallback if flagged: `JukeboxDJ: DJ Turntables`)*

## Short description (max 80)
```
Two real turntables in your pocket. Scratch the vinyl, mix, loop and record.
```
*(75 chars)*

## Full description (max 4000)
```
JukeboxDJ is a real DJ rig in your pocket — two working turntables you can actually scratch, a full mixer, and a jukebox of tracks ready to spin. No account, no ads, works fully offline.

Grab the record and the sound follows your hand: scratches, spinbacks and reverse are driven by a real vinyl engine, not a fake animation. Let go and the platter spins back up like real wax.

WHAT YOU CAN DO
• Two turntables — spinning records with pitch faders, live BPM, cue and one-tap Sync
• Scratch for real — drag the vinyl to scratch, nudge, rip it backwards, drop it on the beat
• AI Auto-Mix — tap a style and the AI beat-matches and blends both decks: 10 hands-on techniques plus 10 fully-autonomous "AI DJ" modes that mix for you
• Scratch FX pads — 10 instant vinyl scratches (baby, chirp, transform, spinback and more) on tap or keys 1–0
• Full mixer — crossfader, channel faders, 3-band EQ with kills, and a sweepable filter per deck
• A living console — the mixer shifts colour and floats musical notes in time with the beat
• Beat loops & echo — beat-locked 1/2/4/8 loops and a tempo-synced echo send
• The Jukebox — six original tracks (house, boom bap, trap, techno, breaks, synthwave) pressed on your device
• Add your own music — drop in your MP3s and JukeboxDJ auto-detects the BPM
• Record your set — capture the whole mix and save it as a file
• Waveform strips for needle-drops, VU meters, a master limiter — a proper booth

PRO INCLUDED — FREE IN THE APP
The Android app comes with JukeboxDJ Pro built in: unlimited recording length at high bitrate, at no cost. Nothing is sold inside the app.

PRIVATE BY DESIGN
JukeboxDJ collects nothing. No accounts, no analytics, no ads, no tracking. Your music and your mixes never leave your device — everything runs on-device and offline.

WHO IT'S FOR
Bedroom DJs, curious beginners who want to learn to beat-match and scratch, and anyone who just wants to grab a record and play. If you've ever wanted to feel a turntable respond to your hand, this is it.

Made by Photon Bounce — https://www.photon-bounce.com
```

## Graphics checklist (files in this folder)
| Asset | Play requirement | File |
| --- | --- | --- |
| App icon | 512×512 PNG, 32-bit | `play-icon-512.png` ✅ |
| Feature graphic | 1024×500 PNG/JPG | `feature-graphic.png` ✅ |
| Phone screenshots | 2–8, 16:9–9:16, ≥320px | `phone-1-decks.png … phone-4-pro.png` (1080×2160) ✅ |
| 7-inch tablet | up to 8, ≥320px | `tablet7-1-console.png`, `tablet7-2-jukebox.png` (1920×1200) ✅ |
| 10-inch tablet | up to 8, ≥1080px | `tablet10-1-console.png`, `tablet10-2-mixer.png` (2560×1600) ✅ |

Screenshots are captured from the real app by `qa/jukeboxdj/gen-play-assets.mjs`.

## Categorization & rating
- **Category:** Music & Audio
- **Tags:** DJ, turntable, scratch, mixer, beat maker
- **Content rating:** Everyone (questionnaire: no objectionable content)
- **Target audience:** 13+ (general)

## Data safety form
- **Data collected / shared:** None.
- Answer every category **"No data collected."** JukeboxDJ has no accounts, no
  analytics, no ads, and makes no network calls in the shipped app — the whole
  console (including the six records) runs on-device and offline.

## App content declarations
- **Ads:** No.
- **In-app purchases:** No (Pro is bundled free in the app).
- **Government app / financial features / health:** No.
- **Data safety:** No data collected or shared.

## Build → what to upload
- Upload the **signed AAB** artifact `jukeboxdj-aab` (`jukeboxdj-release.aab`)
  from the latest `8 · Build Android APK (JukeboxDJ)` workflow run.
- See `../PUBLISH.md` for the one-time upload-key + Play App Signing steps.
