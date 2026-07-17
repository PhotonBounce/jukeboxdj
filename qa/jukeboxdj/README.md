# JukeboxDJ QA

Playwright suites for `projects/jukeboxdj` (never deployed).

Setup: `ln -s ../observer/node_modules node_modules` (shares observer's
playwright install), browser at
`PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

- `smoke.mjs` — boot, record pressing, decks, scratch, loop, crossfader, record
- `audio.mjs` — EQ kill / filter / echo spectra, user-file decode, BPM estimate, mix decode
- `ui.mjs` — pointer scratching, knobs, waveform seeks, CUE, keys, mobile touch
- `landing.mjs` — microsite renders, images, CTAs, SW/manifest, mobile reflow
- `probe1-monkey.mjs` / `probe2-edges.mjs` / `probe3-lifecycle.mjs` — adversarial probes
- `gen-assets.mjs` / `gen-shots.mjs` — icons + gallery screenshots (writes into the app folder)

One QA cycle = the four suites + one probe. Ship rule: 3 clean cycles, each
with a distinct probe.
