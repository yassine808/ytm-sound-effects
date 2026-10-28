# YTM Sound Effects

A Manifest V3 extension for **Brave** (and other Chromium browsers) that puts a
real audio chain on top of **YouTube Music**: a 10-band equalizer, bass and air
shelves, punch compression, warmth saturation, stereo width, reverb and echo —
all live while the track plays, with a spectrum that stays inside the EQ card,
saved profiles, remembered shuffle, and ads silenced.

![Popup](docs/popup.png)

## Features

| | |
|---|---|
| **10-band EQ** | 32 Hz → 16 kHz, ±12 dB per band, with a live gain readout and a centre-zero meter |
| **Bass boost** | Low-shelf at 100 Hz, 0 → +15 dB |
| **Air** | High-shelf at 4.2 kHz, −12 → +12 dB, for an open or darker top end |
| **Punch** | Bus compressor with automatic makeup; adds density without raising the fader |
| **Warmth** | Parallel tanh saturation for harmonic weight and a thicker midrange |
| **Width** | Mid/side stereo width, 0 % (mono) → 200 %; 100 % is exactly neutral |
| **Reverb** | Convolver with an impulse response generated in code (no audio files), adjustable wet/dry mix and 0.3–4 s decay |
| **Echo** | Warm 280 ms delay tap with a short feedback tail and a low-passed repeat |
| **Pre-amp** | −12 → +12 dB before the filters, so a boosted EQ does not clip |
| **Presets** | Flat, Bass, Vocal, Live, Hall, Warm, Night — one click, and the chip stays highlighted only while the settings match |
| **On/off switch** | Silences the effects instantly and restores them with one click; the chain stays connected, so audio never drops out |
| **Live visuals** | A spectrum graph behind the EQ faders only — never behind the rest of the popup (frozen when reduced motion is requested) |
| **Profiles** | Save the current settings under a name, switch between them instantly, delete with a two-click confirmation |
| **Shuffle memory** | YouTube Music forgets shuffle on reload; the extension restores your last explicit choice on every new page |
| **Ad silence** | Ads are detected in the player and muted through the chain, then unmuted when the music returns. The site's own volume is never touched |
| **Persistence** | Settings, profiles and the shuffle preference live in `chrome.storage.local` and apply to every open tab immediately |

## How it works

The extension taps the page's `<video>` element and routes its audio through a
Web Audio graph:

```
<video> ─► source ─► pre-amp ─► EQ ×10 ─► bass ─► air ─► width ─► warmth
        ─► punch ─┬─► dry ───────────────────────────┐
                  ├─► convolver ─► reverb wet ───────┤
                  └─► delay ─► echo wet ─────────────┤
                                                     └─► limiter ─► master ─► analyser ─► destination
```

A few details that matter:

* **One media source per element, forever.** `createMediaElementSource()` can be
  called only once per element; the node is cached so rebuilds reuse it instead
  of throwing `InvalidStateError`.
* **Bypass is acoustic, not structural.** When the switch is off, every gain is
  set to neutral. Disconnecting the graph would silence the tab.
* **The master gain silences ads, not the site.** A `Sponsored` line in the
  player bar (and the player's `ad-showing` state) marks an ad; the master gain
  ramps to zero before the analyser, so no ad audio reaches the output and no
  ad bars reach the visuals. It never touches the page's volume or mute state.
  A visible *Skip* button is clicked when one exists. The player bar's playback
  clock distinguishes a real ad from a stale `ad-showing` class, so the music
  cannot stay muted by accident.
* **YouTube Music is a SPA.** A poll plus a `MutationObserver` watch for the
  player element being replaced on navigation and rebuild the chain when it is.
* **Reverb without assets.** The impulse response is stereo decorrelated noise
  with an exponential decay envelope, rebuilt only when the decay length
  changes.
* **Width is a mid/side matrix.** At 100 % the two halves reconstruct the left
  and right channels exactly; 0 % folds to mono and 200 % stretches the sides.
* **Warmth is parallel, not destructive.** A normalised tanh curve runs beside
  the clean signal, so the dry path never loses detail and 0 % is neutral.
* **Punch is a bus compressor** with automatic makeup gain. At 0 % the ratio is
  1 and the stage is transparent; the safety limiter still follows it.
* **Echo is a short, warm tap** (280 ms, low-passed feedback) rather than a
  second reverb, so it adds depth without smearing the whole mix.
* **A limiter always sits at the end** (threshold −1 dB, ratio 20) so aggressive
  EQ settings cannot clip.
* **The analyser feeds the visuals**, and doubles as a health check: the popup
  polls one frame roughly eighteen times a second to draw the spectrum behind
  the faders, and the debug hook uses the same frame to prove audio is flowing.
* **Shuffle has no ARIA state.** YouTube Music signals it only through the icon
  colour (white on, grey off). The extension saves explicit clicks and restores
  the choice on boot, on `playing`, and after SPA navigation, with a retry cap
  so it never fights the user.

The popup and the page script share one storage key, `ytmse:config`; profiles
live in `ytmse:profiles` and the shuffle choice in `ytmse:shuffle`. The content
script listens to `chrome.storage.onChanged`, so moving a slider is audible
within a few milliseconds and needs no reload.

## Install

1. Download or clone this repository.
2. Open `brave://extensions` (or `chrome://extensions` / `edge://extensions`).
3. Enable **Developer mode**.
4. **Load unpacked** → select this folder.
5. Open <https://music.youtube.com> and start a track.

> Installing an extension does **not** inject it into tabs that are already
> open. If the popup says *"Reload the YouTube Music tab"*, use the button — it
> reloads the tab for you.

## Using it

Open the toolbar popup while a YouTube Music tab is active. The switch in the
header turns the whole chain on and off; the settings are kept, so flipping it
back restores exactly what you had. Move any slider and the change is audible
immediately. **Reset all** sits in the footer, always visible — no scrolling.

Click a preset chip to jump to a known-good starting point:

| Preset | Character |
|---|---|
| Flat | Neutral reference (also the reset state) |
| Bass | Low end +8 dB, slightly scooped mids |
| Vocal | Presence around 1–2 kHz, tame lows |
| Live | Small room reverb, gentle low-mid cut, a little width and echo |
| Hall | Long 3.2 s tail, wide and darker |
| Warm | Bass +5 dB, −3 dB air, 55 % saturation, short room |
| Night | Compressed and darker, with the top end pulled back |

**Profiles.** The row above the footer saves and loads named setups. Pick one
to apply it immediately; **Save…** turns the row into a name field (Enter saves,
Escape cancels); the **×** deletes, and asks for a second click first. A profile
captures the whole chain: pre-amp, all ten bands, bass, air, width, punch,
warmth, reverb and echo.

**Effects.** The **Effects** card holds the non-EQ stages. **Bass** and **Air**
are broad shelves; **Punch** compresses; **Warmth** adds parallel saturation;
**Width** works the mid/side image; **Reverb** and **Decay** shape the room;
**Echo** adds a short repeat. Every value has a neutral point, so the power
switch and **Reset all** leave the sound untouched.

**Shuffle.** Toggle shuffle in YouTube Music once. The extension stores that
explicit choice and restores it whenever the page is opened again; turning it
off is remembered just as firmly. It only acts on clicks, so it never fights a
shuffle you change yourself.

**Ads.** While YouTube Music plays an ad, the chain mutes itself — no ad audio,
and the spectrum stops dancing. When a *Skip* button actually appears it is
clicked; otherwise the ad finishes silently and the music returns at the same
volume. The page's own volume and mute state are never modified.

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
// {
//   attached: true,  context: "running",  level: 0.043,
//   paused: false,   muted: false,        volume: 0.5,
//   shuffle: true,   shufflePref: true,
//   ad: false,       chainMuted: false,
//   config: { ... }, lastError: null
// }
```

`level` is the RMS after the limiter and the ad mute: if it is `0` while a
track is playing, the audio is not reaching the graph. `ad` turns on while the
player is in an ad and `chainMuted` reports the master gain state. `shuffle` is
what the button shows right now; `shufflePref` is the remembered choice (`null`
until shuffle has been clicked once).

`__ytmse.frame()` returns the current spectrum (`bars`, `bands`, `level`) that
drives the visuals, and `__ytmse.rescan()` forces a fresh look for the player
element.

## Project layout

```
manifest.json   MV3 manifest (storage + music.youtube.com content script)
audio.js        the graph: EQ, shelves, M/S width, saturation, compressor,
                reverb, echo, limiter, master mute, analyser
content.js      discovery, lifecycle, storage sync, shuffle keeper, ad guard,
                frame producer, debug hook
popup.html      popup markup (switch, EQ faders, effects card, profiles)
popup.css       popup styling, fixed 380 px layout, reduced-motion rules
popup.js        sliders, presets, profiles, EQ-only spectrum, persistence
icons/          16 / 48 / 128 px (official YouTube Music icon)
docs/popup.png  screenshot used above
```

## Verified

* `node --check` on every script; manifest parses; every referenced asset exists.
* The whole graph was unit-tested against a stubbed Web Audio API (wiring,
  gains, M/S width, saturation curve, echo loop, bypass neutrality, single-source
  reuse); the master mute and analyser were verified against the real player.
* Loaded unpacked in **Brave 156** (Chromium 156) against real YouTube Music:
  chain attached, `AudioContext` running, post-limiter RMS **0.030 → 0.064** on
  playback, and a config written to storage changed the applied filters and the
  output level.
* Popup rendered and measured in **Brave 156** at **380×588 px** (2× DPR) —
  inside Chromium's 600 px limit — with every input labelled, the spectrum moving
  behind the EQ faders only, and the profile row behaving (placeholder selected,
  delete disabled until a real profile exists).
* Shuffle, live: turn on → reopen in a fresh tab with YouTube Music's local
  storage cleared → still on; turn off → reopen → still off.
* Ads, live: a real ad break was detected (`ad-showing` + `Sponsored`) and the
  chain muted (`level` 0). In an ad-free window, forcing the ad state measured
  RMS **0.053 → 0 → 0.162** across mute and restore, and a synthetic visible
  *Skip* button was clicked by the ad guard.

Not verified: how it sounds on your speakers. That needs your ears.

## License

MIT
