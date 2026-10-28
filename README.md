# YTM Sound Effects

A Chrome (Manifest V3) extension that puts a real audio chain on top of
**YouTube Music**: a 10-band equalizer, bass boost and a reverb, all live while
the track plays.

![Popup](docs/popup.png)

## Features

| | |
|---|---|
| **10-band EQ** | 32 Hz → 16 kHz, ±12 dB per band, with a live gain readout and a centre-zero meter |
| **Bass boost** | Low-shelf at 100 Hz, 0 → +15 dB |
| **Reverb** | Convolver with an impulse response generated in code (no audio files), adjustable wet/dry mix and 0.3–4 s decay |
| **Pre-amp** | −12 → +12 dB before the filters, so a boosted EQ does not clip |
| **Presets** | Flat, Bass, Vocal, Live, Hall — one click, and the chip stays highlighted only while the settings match |
| **Bypass** | The `LIVE / Bypassed` pill switches the chain to neutral without ever disconnecting it |
| **Persistence** | Settings live in `chrome.storage.local` and are applied to every open tab immediately |

## How it works

The extension taps the page's `<video>` element and routes its audio through a
Web Audio graph:

```
<video> ──► MediaElementSource ──► pre-amp ──► EQ ×10 ──► bass shelf ──┬──► dry ─────┐
                                                                       └──► convolver ─┴──► limiter ──► analyser ──► destination
```

A few details that matter:

* **One media source per element, forever.** `createMediaElementSource()` can be
  called only once per element; the node is cached so rebuilds reuse it instead
  of throwing `InvalidStateError`.
* **Bypass is acoustic, not structural.** When disabled, every gain is set to
  neutral. Disconnecting the graph would silence the tab.
* **YouTube Music is a SPA.** A poll plus a `MutationObserver` watch for the
  player element being replaced on navigation and rebuild the chain when it is.
* **Reverb without assets.** The impulse response is stereo decorrelated noise
  with an exponential decay envelope, rebuilt only when the decay length
  changes.
* **A limiter always sits at the end** (threshold −1 dB, ratio 20) so aggressive
  EQ settings cannot clip.
* **The analyser is a health check**, not decoration: it is what the popup and
  the debug hook use to prove audio is actually flowing.

The popup and the page script share one storage key, `ytmse:config`; the content
script listens to `chrome.storage.onChanged`, so moving a slider is audible
within a few milliseconds and needs no reload.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
3. Enable **Developer mode**.
4. **Load unpacked** → select this folder.
5. Open <https://music.youtube.com> and start a track.

> Installing an extension does **not** inject it into tabs that are already
> open. If the popup says *"Reload the YouTube Music tab"*, use the button — it
> reloads the tab for you.

## Using it

Open the toolbar popup while a YouTube Music tab is active. Move any slider and
the change is audible immediately. Click a preset chip to jump to a known-good
starting point, and use **Reset all** to return to a flat, neutral chain.

| Preset | Character |
|---|---|
| Flat | Neutral reference (also the reset state) |
| Bass | Low end +8 dB, slightly scooped mids |
| Vocal | Presence around 1–2 kHz, tame lows |
| Live | Small room reverb, gentle low-mid cut |
| Hall | Long 3.2 s tail, wide and darker |

## Troubleshooting

**No sound at all after installing.** Reload the tab (the popup offers the
button). A tab that was open before the extension was installed has no content
script.

**The popup says the effects are not active.** Same cause: the page was not
injected. Reload it.

**Everything is audible but nothing changes.** The default config is flat — pull
a band or the bass slider, or click a preset.

**"This media element is already owned by another AudioContext."** Another audio
extension (equalizer, volume booster) grabbed the `<video>` first, and the
browser allows only one owner. Disable the other extension and reload.

**The tab went silent.** That can only happen if the media is cross-origin
without CORS; YouTube Music serves its audio from a same-origin `blob:` URL, so
this should not happen here. If it does, reload the tab to restore the native
output.

## Debugging

The content script exposes a small, isolated-world-only hook:

```js
// DevTools console, context = "YTM Sound Effects"
__ytmse.status();
// { attached: true, context: "running", level: 0.043, paused: false, muted: false, ... }
```

`level` is the RMS after the limiter: if it is `0` while a track is playing, the
audio is not reaching the graph.

## Project layout

```
manifest.json   MV3 manifest (storage + music.youtube.com content script)
audio.js        the graph: filters, impulse response, limiter, analyser
content.js      discovery, lifecycle, storage sync, in-page badge, ping
popup.html      popup markup
popup.css       popup styling
popup.js        sliders, presets, persistence
icons/          16 / 48 / 128 px (official YouTube Music icon)
docs/popup.png  screenshot used above
```

## Verified

* `node --check` on every script; manifest parses; every referenced asset exists.
* The whole graph was unit-tested against a stubbed Web Audio API (wiring,
  gains, IR generation, bypass neutrality, single-source reuse).
* Loaded unpacked in Chromium 156 against real YouTube Music: chain attached,
  `AudioContext` running, post-limiter RMS **0.030 → 0.064** on playback, and a
  config written to storage changed the applied filters and the output level.

Not verified: how it sounds on your speakers. That needs your ears.

## License

MIT
