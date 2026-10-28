# YTM Sound Effects

A Chrome (Manifest V3) extension that puts an audio effects chain in front of
`music.youtube.com`: a **10-band equalizer**, a **bass boost**, **reverb**, and a
**master pre-amp** — with five presets and settings that persist across reloads
and tracks.

No bundler, no npm, no build step, no external assets. Plain JS + Web Audio.

## What it does

Everything runs inside the page through a `MediaElementAudioSourceNode` attached
to YouTube Music's `<video>` element:

```
<video> ─► source ─► pre-amp ─► EQ ×10 ─► bass shelf ─┬─► dry ───────────┐
                                                      └─► convolver ─► wet ┴─► limiter ─► speakers
```

- **EQ** — 10 peaking filters at 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz,
  ±12 dB each (Q ≈ 1.1).
- **Bass boost** — low shelf at 100 Hz, 0…+15 dB.
- **Reverb** — convolution with an impulse response generated in code (stereo
  decaying noise), wet/dry mix 0…100 %, decay 0.3…4 s.
- **Limiter** — always the last node before the output (threshold −1 dB,
  ratio 20, knee 0) so boosted bands cannot clip.
- **Bypass** — the master switch sets every stage to neutral (0 dB, reverb 0 %)
  instead of disconnecting anything, so audio never drops out.
- Changes apply live (smoothed ~20 ms) while a track is playing.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing
   `manifest.json`).
4. Open <https://music.youtube.com> and start a track.
5. Click the extension icon to open the popup and shape the sound.

Click anywhere on the page (or press a key) once if you hear no effect: Chrome's
autoplay policy keeps the `AudioContext` suspended until a user gesture.

## Presets

| Preset | Pre-amp | EQ (32 Hz → 16 kHz, dB)                                    | Bass | Reverb mix | Decay |
| ------ | ------- | ---------------------------------------------------------- | ---- | ---------- | ----- |
| Flat   | 0 dB    | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0                                | 0 dB | 0 %        | 1.8 s |
| Bass   | −2 dB   | +6, +5.5, +3, +1, 0, −1, −1, +0.5, +1, +1                   | 8 dB | 5 %        | 1.2 s |
| Vocal  | 0 dB    | −3, −2, −1, +1, +3, +4, +3, +1.5, 0, −1                     | 0 dB | 12 %       | 1.0 s |
| Live   | −1 dB   | +2.5, +2, +1, 0, −1.5, 0, +1, +2, +2, +2                    | 3 dB | 30 %       | 1.7 s |
| Hall   | −2 dB   | +1.5, +1, 0, −1, −1, 0, +1, +1, 0, +0.5                     | 2 dB | 45 %       | 3.2 s |

**Reset** returns to Flat (effects on, everything neutral).

All settings live in `chrome.storage.local` under the key `ytmse:config`; the
content script listens for changes, so the popup updates the sound instantly and
values survive page reloads, SPA navigation and track changes.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest (`storage` permission, content script on `music.youtube.com`). |
| `audio.js` | Pure Web Audio graph builder. No `chrome.*` calls. Exposes `window.YTMAudio`. |
| `content.js` | Finds the `<video>`, builds/rebuilds the chain, syncs with storage. |
| `popup.html` / `popup.css` / `popup.js` | The UI. |
| `icons/` | 16/48/128 px icons. |

## Known limitations

- **CORS / silence.** If `googlevideo.com` served the media without CORS headers,
  a `MediaElementAudioSourceNode` would output silence. In practice YouTube
  Music serves media with CORS enabled and the chain works, but this is the
  failure mode to check first if you hear nothing. Fallbacks would be
  `chrome.tabCapture` (offscreen document) or `video.captureStream()`, neither of
  which is implemented in v1.
- **One media source per element, ever.** The browser allows a single
  `MediaElementAudioSourceNode` per element. A second attempt throws
  `InvalidStateError` — usually because another audio extension (or an earlier
  copy of this one) already claimed the element. The chain reuses its cached
  source node on rebuilds; if it still fails, `YTMAudio.SoundChain.lastError`
  holds a readable message and the console shows a warning. Fix: disable the
  other audio extension and reload the page.
- **Ads.** Ads play through the same `<video>` element but their own loudness is
  not normalized like music, so boosted settings can sound harsh during an ad.
  Toggle the master switch off if that matters.
- **Element swaps / SPA navigation** are handled by a `MutationObserver` plus a
  1 s poll; there can be a brief gap (well under a second) right after a track
  change while the new element is discovered.
- **No live cable-level verification.** Bypass is neutral in theory (0 dB gains,
  0 % wet); only listening tests can confirm no audible colouration.
- Chrome only (not tested on Edge/Firefox). The popup cannot resume the page's
  `AudioContext` — only a gesture on the music.youtube.com page can.
