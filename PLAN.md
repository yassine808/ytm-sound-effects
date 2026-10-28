# YTM Sound Effects — Plan

Brave / Chromium (MV3) extension that adds an audio effects chain to YouTube Music:
**reverb, multi-band equalizer, bass boost**, plus master volume.

> Status: v0.4 ships the MVP below plus Air, Punch, Warmth, Width and Echo
> effects, and the visualizer is scoped to the EQ card.

Target site: `https://music.youtube.com/*`

---

## 1. Goal

A popup that lets me shape the sound of whatever is playing on YouTube Music,
with settings that persist and apply instantly, and **zero breakage of normal
playback** (no silence, no double audio, no lost controls).

## 2. MVP scope

| Feature | Detail |
|---|---|
| Equalizer | 10 peaking bands: 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz. Gain −12…+12 dB each. |
| Bass boost | Shelf filter at 100 Hz, 0…+15 dB (one slider, cleaner than the EQ low band). |
| Reverb | Convolver with an **IR generated in code** (decaying noise), wet/dry mix 0…100 %, decay length 0.3–4 s. |
| Master | Pre-amp gain + on/off bypass toggle. |
| Persistence | `chrome.storage.local`, restored on load, applied live. |
| Presets | Flat / Bass / Vocal / Live / Hall — hardcoded JSON. |

Non-goals for v1: per-track profiles, compressor UI, visualizer, mobile, Firefox.

## 3. Audio architecture (the risky part — read before coding)

```
<video> ──► MediaElementSource ──► preamp ──► EQ (10 biquads) ──► bass shelf
              │                                                      │
              └──────────────────────────────────────────────► dry ─┤
                                        convolver(reverb) ──► wet ──┤
                                                                    ▼
                                                          limiter ──► destination
```

Key decisions / gotchas:

1. **One `MediaElementSource` per element, ever.** Creating a second one throws
   `InvalidStateError`. If the graph is rebuilt, reuse the cached source node.
2. **CORS silence risk.** If `googlevideo.com` media is fetched without CORS,
   the source node outputs silence. Verify on day 1 with a 5-line probe.
   Fallbacks in order: (a) confirm it works, (b) `chrome.tabCapture` in an
   offscreen document and play the captured stream through the chain,
   (c) `captureStream()` on the element.
3. **AudioContext starts suspended** (autoplay policy). `resume()` on first
   user gesture (click/keydown in page or popup).
4. **SPA video swap.** YouTube Music replaces the `<video>` node on navigation.
   Detect with a `MutationObserver` + a 1 s interval fallback; rebuild the chain
   and re-attach.
5. **Disable path.** Bypass = set preamp to 0 dB and everything else to neutral,
   *not* by disconnecting (disconnecting kills audio).

## 4. File layout (no build step, plain MV3 — matches `D:\projects\sonarcube-extension`)

```
ytm-sound-effects/
  manifest.json      # MV3, content script on music.youtube.com, popup, storage
  audio.js           # graph builder + filter classes (pure, no chrome APIs)
  content.js         # finds <video>, builds graph, listens for setting changes
  popup.html
  popup.css
  popup.js           # sliders, presets, writes to chrome.storage.local
  icons/16|48|128.png
  README.md
  PLAN.md
```

No bundler, no npm. One script tag order in the content script array:
`audio.js`, then `content.js`.

## 5. Milestones

**M1 — Prove the audio path (first, ~1 hour)**
- [ ] Content script on music.youtube.com grabs the `<video>`, builds
      source → gain → destination at unity gain.
- [ ] Audio still plays, volume slider still works, no doubling.
- **Acceptance:** sound is unchanged; no console errors on a full track.

**M2 — Filter chain**
- [ ] 10-band EQ + bass shelf wired in `audio.js` with a `setParams(cfg)` API.
- [ ] Hardcoded "bass boost" test proves an audible, non-clipping change.
- **Acceptance:** +12 dB @ 64 Hz is clearly audible; no distortion at unity.

**M3 — Reverb**
- [ ] Synthesized IR (noise × exponential decay, stereo), wet/dry crossfade.
- **Acceptance:** mix at 0 % is bit-identical to dry; at 100 % is clearly wet.

**M4 — Popup UI**
- [ ] Sliders + bypass + preset dropdown, live updates (no reload).
- [ ] Values persist across reload and across tracks.
- **Acceptance:** change a band → audible within ~50 ms.

**M5 — Robustness**
- [ ] Survives SPA navigation, video swap, ad playback, tab sleep.
- [ ] Bypass restores fully neutral sound.
- [ ] Settings reset button.

## 6. Risks

| Risk | Mitigation |
|---|---|
| CORS-tainted media → silence | M1 probe first; tabCapture fallback |
| Another extension owns the media element | Detect `InvalidStateError`, show a clear popup warning |
| Ads / different media element | Re-scan on every element swap |
| EQ clipping | Post-chain `DynamicsCompressor` limiter, threshold −1 dB |

## 7. Open questions (confirm before M1)

1. Chrome only, or also Edge/Firefox? (Firefox MV3 differs on `storage`.)
2. Do I want a floating in-page panel instead of / in addition to the popup?
3. Import/export settings as JSON — v1 or later?
