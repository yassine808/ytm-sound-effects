/*
 * YTM Sound Effects - popup UI.
 * Reads/writes chrome.storage.local["ytmse:config"]; the content script applies
 * changes live and streams analyser frames for the spectrum graph.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'ytmse:config';
  var BARS = 40;
  var FRAME_MS = 55;

  var api = window.YTMAudio;
  var BANDS = (api && api.BANDS) || [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  var DEFAULTS = api && api.defaultConfig
    ? api.defaultConfig()
    : {
        enabled: true,
        preampDb: 0,
        eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        bassDb: 0,
        airDb: 0,
        width: 1,
        punch: 0,
        warmth: 0,
        reverbMix: 0,
        reverbDecay: 1.8,
        echoMix: 0
      };
  var normalize = api && api.normalizeConfig ? api.normalizeConfig : function (c) { return c || DEFAULTS; };

  // Hardcoded presets. eq is the 10-band gain array (dB), in BANDS order.
  var PRESETS = {
    Flat: {
      preampDb: 0, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bassDb: 0,
      airDb: 0, width: 1, punch: 0, warmth: 0,
      reverbMix: 0, reverbDecay: 1.8, echoMix: 0
    },
    Bass: {
      preampDb: -2, eq: [6, 5.5, 3, 1, 0, -1, -1, 0.5, 1, 1], bassDb: 8,
      airDb: 0, width: 1.05, punch: 0.1, warmth: 0.08,
      reverbMix: 0.05, reverbDecay: 1.2, echoMix: 0
    },
    Vocal: {
      preampDb: 0, eq: [-3, -2, -1, 1, 3, 4, 3, 1.5, 0, -1], bassDb: 0,
      airDb: 2, width: 1.05, punch: 0.2, warmth: 0.12,
      reverbMix: 0.12, reverbDecay: 1.0, echoMix: 0.04
    },
    Live: {
      preampDb: -1, eq: [2.5, 2, 1, 0, -1.5, 0, 1, 2, 2, 2], bassDb: 3,
      airDb: 1, width: 1.35, punch: 0.15, warmth: 0.1,
      reverbMix: 0.3, reverbDecay: 1.7, echoMix: 0.12
    },
    Hall: {
      preampDb: -2, eq: [1.5, 1, 0, -1, -1, 0, 1, 1, 0, 0.5], bassDb: 2,
      airDb: 0, width: 1.5, punch: 0, warmth: 0.05,
      reverbMix: 0.45, reverbDecay: 3.2, echoMix: 0.15
    },
    Warm: {
      preampDb: -1, eq: [3, 2, 1, 0, 0, 0, -1, -1, -2, -2], bassDb: 5,
      airDb: -3, width: 1.1, punch: 0.15, warmth: 0.55,
      reverbMix: 0.12, reverbDecay: 1.5, echoMix: 0.08
    },
    Night: {
      preampDb: -3, eq: [-2, -1, 0, 1, 1, 0, 0, -2, -3, -3], bassDb: 2,
      airDb: -4, width: 0.9, punch: 0.6, warmth: 0.1,
      reverbMix: 0.08, reverbDecay: 1.2, echoMix: 0
    }
  };

  var els = {};
  var bandInputs = [];
  var bandOuts = [];
  var bandMeters = [];
  var bandWraps = [];
  var saveTimer = null;
  var storageBroken = false;

  var PROFILES_KEY = 'ytmse:profiles';
  var profiles = {};
  var deleteArmed = false;
  var deleteTimer = null;

  var viz = {
    canvas: null,
    ctx: null,
    w: 0,
    h: 0,
    dpr: 0,
    timer: null,
    busy: false,
    fails: 0,
    reduced: false
  };
  var smoothBars = new Array(BARS);
  var i;
  for (i = 0; i < BARS; i++) smoothBars[i] = 0;

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  function fmtDb(v) {
    var n = Math.round(v * 10) / 10;
    return (n > 0 ? '+' : '') + n + ' dB';
  }

  /** Compact form for the narrow EQ columns: "+1.5", "0", "-2". */
  function fmtBand(v) {
    var n = Math.round(v * 10) / 10;
    if (n === 0) return '0';
    return (n > 0 ? '+' : '') + n;
  }

  function fmtHz(hz) {
    return hz >= 1000 ? hz / 1000 + 'k' : String(hz);
  }

  function paintBand(index, v) {
    var meter = bandMeters[index];
    var band = bandWraps[index];
    if (!meter || !band) return;

    var pct = (Math.abs(v) / 12) * 50;
    meter.style.height = pct + '%';

    if (v > 0) {
      meter.style.bottom = '50%';
      meter.style.top = 'auto';
    } else if (v < 0) {
      meter.style.bottom = 'auto';
      meter.style.top = '50%';
    }
    meter.classList.toggle('is-cut', v < 0);
    band.classList.toggle('is-boost', v > 0);
    band.classList.toggle('is-cut', v < 0);
    band.classList.toggle('is-flat', v === 0);
  }

  function paintRange(el) {
    if (!el) return;
    var min = parseFloat(el.min);
    var max = parseFloat(el.max);
    var value = parseFloat(el.value);
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 100;
    if (!isFinite(value)) value = min;
    var pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--p', Math.max(0, Math.min(100, pct)) + '%');
  }

  function paintRanges() {
    ['preamp', 'bass', 'air', 'width', 'punch', 'warmth', 'mix', 'decay', 'echo'].forEach(function (key) {
      paintRange(els[key]);
    });

    for (var b = 0; b < bandInputs.length; b++) {
      paintBand(b, parseFloat(bandInputs[b].value) || 0);
    }
  }

  function syncChips(name) {
    var chips = document.querySelectorAll('.chip[data-preset]');
    for (var c = 0; c < chips.length; c++) {
      var on = chips[c].dataset.preset === name;
      chips[c].classList.toggle('is-active', on);
      chips[c].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function matchPreset(cfg) {
    var EPS = 1e-6;
    for (var name in PRESETS) {
      if (!Object.prototype.hasOwnProperty.call(PRESETS, name)) continue;
      var p = PRESETS[name];
      if (Math.abs(p.preampDb - cfg.preampDb) > EPS) continue;
      if (Math.abs(p.bassDb - cfg.bassDb) > EPS) continue;
      if (Math.abs(p.airDb - cfg.airDb) > EPS) continue;
      if (Math.abs(p.width - cfg.width) > EPS) continue;
      if (Math.abs(p.punch - cfg.punch) > EPS) continue;
      if (Math.abs(p.warmth - cfg.warmth) > EPS) continue;
      if (Math.abs(p.reverbMix - cfg.reverbMix) > EPS) continue;
      if (Math.abs(p.reverbDecay - cfg.reverbDecay) > EPS) continue;
      if (Math.abs(p.echoMix - cfg.echoMix) > EPS) continue;

      var sameEq = true;
      for (var e = 0; e < p.eq.length; e++) {
        if (Math.abs(p.eq[e] - cfg.eq[e]) > EPS) {
          sameEq = false;
          break;
        }
      }
      if (sameEq) return name;
    }
    return null;
  }

  function showNote(text, actionLabel, actionFn) {
    if (!els.note) return;
    if (els.noteText) els.noteText.textContent = text || '';
    else els.note.textContent = text || '';
    els.note.hidden = !text;

    // Any visible note adds a row; hide the footer so the popup stays inside
    // the 600 px limit instead of growing a scrollbar.
    if (document.body) document.body.classList.toggle('has-note', !!text);

    var hasAction = !!(text && actionLabel && actionFn);
    els.note.dataset.tab = hasAction ? '1' : '';

    if (els.noteAction) {
      els.noteAction.hidden = !hasAction;
      els.noteAction.textContent = actionLabel || '';
      els.noteAction.onclick = hasAction
        ? function () {
            try {
              actionFn();
            } catch (e) {
              /* ignore */
            }
          }
        : null;
    }
  }

  function hideTabNote() {
    if (els.note && els.note.dataset.tab === '1') showNote('');
  }

  function storageAvailable() {
    return typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
  }

  // ---------------------------------------------------------------------------
  // transport: playback controls + smoothly interpolated progress
  // ---------------------------------------------------------------------------

  var transport = {
    tabId: null,
    enabled: false,
    paused: true,
    duration: 0,
    baseTime: 0,
    baseAt: 0,
    shown: 0,
    shuffle: null,
    holdUntil: 0,
    seekUntil: 0,
    lastSeekAt: 0,
    dragging: false,
    raf: null,
    lastCur: '',
    lastDur: ''
  };

  function fmtTime(seconds) {
    var total = Math.max(0, Math.floor(isFinite(seconds) ? seconds : 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function applyPlayState(paused) {
    transport.paused = !!paused;
    if (els.player) els.player.classList.toggle('is-playing', !transport.paused);
    if (els.playBtn) {
      var label = transport.paused ? 'Play' : 'Pause';
      els.playBtn.setAttribute('aria-label', label);
      els.playBtn.title = label;
    }
  }

  function applyShuffle(on) {
    if (typeof on === 'boolean') transport.shuffle = on;
    var active = transport.shuffle === true;
    if (!els.shuffleBtn) return;
    els.shuffleBtn.classList.toggle('is-active', active);
    els.shuffleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function showProgress(seconds) {
    var pct = transport.duration > 0
      ? Math.max(0, Math.min(1, seconds / transport.duration))
      : 0;

    if (els.progressFill) els.progressFill.style.width = (pct * 100).toFixed(3) + '%';
    if (els.progressHead) els.progressHead.style.left = (pct * 100).toFixed(3) + '%';
    if (els.progress) {
      els.progress.setAttribute('aria-valuemax', String(Math.round(transport.duration)));
      els.progress.setAttribute('aria-valuenow', String(Math.round(seconds)));
      els.progress.setAttribute(
        'aria-valuetext',
        fmtTime(seconds) + ' of ' + fmtTime(transport.duration)
      );
    }

    var cur = fmtTime(transport.duration > 0 ? seconds : 0);
    if (cur !== transport.lastCur) {
      if (els.curTime) els.curTime.textContent = cur;
      transport.lastCur = cur;
    }

    var total = fmtTime(transport.duration);
    if (total !== transport.lastDur) {
      if (els.durTime) els.durTime.textContent = total;
      transport.lastDur = total;
    }
  }

  /** One analyser frame also carries the transport snapshot (~18 fps). */
  function renderTransport(frame) {
    if (!frame || typeof frame !== 'object') return;

    var duration = Number(frame.duration);
    var current = Number(frame.currentTime);
    if (!isFinite(duration) || duration < 0) duration = 0;
    if (!isFinite(current) || current < 0) current = 0;

    var now = performance.now();
    var previousDuration = transport.duration;
    transport.duration = duration;

    // While dragging, the pointer owns the position. For a moment after a
    // click, ignore stale frames so the bar does not jump back before the
    // player reports the new time.
    if (transport.dragging) return;
    if (now < transport.seekUntil) {
      if (transport.shown > duration) transport.shown = duration;
      if (now >= transport.holdUntil) {
        applyPlayState(frame.paused === true);
        if (typeof frame.shuffle === 'boolean') applyShuffle(frame.shuffle);
      }
      return;
    }

    var expected = transport.baseTime +
      (transport.paused ? 0 : (now - transport.baseAt) / 1000);
    var jumped = Math.abs(current - expected) > 1.5 ||
      Math.abs(duration - previousDuration) > 0.75;

    transport.baseTime = current;
    transport.baseAt = now;
    if (jumped) transport.shown = current;
    if (transport.shown > duration) transport.shown = duration;

    // Ignore stale snapshots for a moment after a click so the optimistic
    // icon doesn't flicker back.
    if (now >= transport.holdUntil) {
      applyPlayState(frame.paused === true);
      if (typeof frame.shuffle === 'boolean') applyShuffle(frame.shuffle);
    }
  }

  function progressTick(now) {
    transport.raf = window.requestAnimationFrame(progressTick);

    if (transport.dragging) return;

    var duration = transport.duration;
    if (!(duration > 0)) {
      transport.shown = 0;
      showProgress(0);
      return;
    }

    var target = transport.baseTime +
      (transport.paused ? 0 : Math.max(0, now - transport.baseAt) / 1000);
    if (target > duration) target = duration;

    var diff = target - transport.shown;
    if (Math.abs(diff) > 1.5) transport.shown = target;
    else transport.shown += diff * 0.3;

    transport.shown = Math.max(0, Math.min(duration, transport.shown));
    showProgress(transport.shown);
  }

  function setTransportEnabled(on) {
    transport.enabled = !!on;
    if (!transport.enabled) {
      transport.tabId = null;
      transport.duration = 0;
      transport.shown = 0;
      transport.baseTime = 0;
      transport.paused = true;
      transport.shuffle = null;
      applyShuffle(false);
      applyPlayState(true);
      showProgress(0);
    }
    [els.prevBtn, els.playBtn, els.nextBtn, els.shuffleBtn].forEach(function (button) {
      if (button) button.disabled = !transport.enabled;
    });
    if (els.progress) {
      els.progress.setAttribute('aria-disabled', transport.enabled ? 'false' : 'true');
      els.progress.tabIndex = transport.enabled ? 0 : -1;
    }
    if (els.player) els.player.classList.toggle('is-disabled', !transport.enabled);
  }

  function sendCommand(cmd, value) {
    if (!transport.tabId || !transport.enabled) return;
    var message = { type: 'YTMSE_CMD', cmd: cmd };
    if (typeof value === 'number' && isFinite(value)) message.value = value;
    try {
      chrome.tabs.sendMessage(transport.tabId, message, function () {
        // Read lastError so a closed tab does not log a noisy exception.
        if (chrome.runtime && chrome.runtime.lastError) return;
      });
    } catch (e) {
      /* the next frame poll will disable the controls if the tab is gone */
    }
  }

  function seekFraction(clientX) {
    var rail = els.progressRail || els.progress;
    if (!rail || !isFinite(clientX)) return 0;
    var rect = rail.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function previewSeek(fraction, live) {
    if (!(transport.duration > 0)) return;
    transport.shown = Math.max(0, Math.min(1, fraction)) * transport.duration;
    showProgress(transport.shown);

    // Keep the music following the finger while dragging, not only on release.
    if (live && transport.enabled) {
      var now = performance.now();
      if (now - transport.lastSeekAt >= 120) {
        transport.lastSeekAt = now;
        transport.baseTime = transport.shown;
        transport.baseAt = now;
        sendCommand('seek', transport.shown);
      }
    }
  }

  function commitSeek() {
    if (!transport.enabled || !(transport.duration > 0)) return;
    var now = performance.now();
    var target = Math.max(0, Math.min(transport.duration, transport.shown));
    transport.shown = target;
    transport.baseTime = target;
    transport.baseAt = now;
    transport.seekUntil = now + 900;
    transport.holdUntil = now + 700;
    transport.lastSeekAt = now;
    showProgress(target);
    sendCommand('seek', target);
  }

  function seekBy(seconds) {
    if (!transport.enabled || !(transport.duration > 0)) return;
    transport.shown = Math.max(0, Math.min(transport.duration, transport.shown + seconds));
    commitSeek();
  }

  // ---------------------------------------------------------------------------
  // live spectrum (canvas behind the UI + the EQ meters)
  // ---------------------------------------------------------------------------

  function fitViz() {
    if (!viz.canvas || !els.eqStage) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, els.eqStage.clientWidth);
    var h = Math.max(1, els.eqStage.clientHeight);
    if (w === viz.w && h === viz.h && dpr === viz.dpr && viz.ctx) return;

    viz.w = w;
    viz.h = h;
    viz.dpr = dpr;
    viz.canvas.width = Math.round(w * dpr);
    viz.canvas.height = Math.round(h * dpr);
    viz.ctx = viz.canvas.getContext('2d');
    if (viz.ctx) viz.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawSpectrum() {
    var ctx = viz.ctx;
    if (!ctx) return;

    var w = viz.w;
    var h = viz.h;
    ctx.clearRect(0, 0, w, h);

    var gap = 2;
    var barWidth = Math.max(1, (w - gap * (BARS - 1)) / BARS);
    var gradient = ctx.createLinearGradient(0, h, 0, h * 0.12);
    gradient.addColorStop(0, 'rgba(255, 45, 45, 0.42)');
    gradient.addColorStop(0.6, 'rgba(255, 74, 74, 0.16)');
    gradient.addColorStop(1, 'rgba(255, 120, 120, 0)');
    ctx.fillStyle = gradient;

    for (var b = 0; b < BARS; b++) {
      var v = smoothBars[b];
      if (v <= 0.004) continue;

      var bh = Math.max(2, Math.pow(v, 1.15) * h * 0.86);
      var x = b * (barWidth + gap);
      var y = h - bh;
      var r = Math.min(barWidth / 2, 3);

      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, bh, [r, r, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, barWidth, bh);
      }
    }
  }

  function renderFrame(res) {
    for (var b = 0; b < BARS; b++) {
      var rawBar = res.bars && typeof res.bars[b] === 'number' ? res.bars[b] : 0;
      var target = Math.min(1, Math.pow(rawBar, 0.72) * 1.12);
      smoothBars[b] += (target - smoothBars[b]) * 0.32;
    }

    drawSpectrum();
  }

  function requestFrame(tabId) {
    viz.busy = true;
    try {
      chrome.tabs.sendMessage(tabId, { type: 'YTMSE_FRAME' }, function (res) {
        viz.busy = false;
        if (chrome.runtime.lastError || !res) {
          viz.fails += 1;
          if (viz.fails > 4) {
            stopViz();
            setTransportEnabled(false);
          }
          return;
        }
        viz.fails = 0;
        renderTransport(res);
        if (res.ok === true) renderFrame(res);
      });
    } catch (e) {
      viz.busy = false;
      stopViz();
    }
  }

  function stopViz() {
    if (viz.timer) {
      clearTimeout(viz.timer);
      viz.timer = null;
    }
    viz.busy = false;
  }

  function startViz(tabId) {
    if (!viz.canvas || !tabId || viz.timer) return;
    fitViz();

    // Users who asked for less motion still get the current spectrum, just
    // frozen instead of animated.
    if (viz.reduced) {
      requestFrame(tabId);
      return;
    }

    var tick = function () {
      viz.timer = setTimeout(tick, FRAME_MS);
      if (viz.busy) return;
      requestFrame(tabId);
    };
    viz.timer = setTimeout(tick, 0);
  }

  // ---------------------------------------------------------------------------
  // build EQ UI
  // ---------------------------------------------------------------------------

  function buildEq() {
    var frag = document.createDocumentFragment();

    BANDS.forEach(function (hz, index) {
      var band = document.createElement('div');
      band.className = 'band is-flat';

      var input = document.createElement('input');
      input.type = 'range';
      input.className = 'vert';
      input.min = '-12';
      input.max = '12';
      input.step = '1';
      input.value = '0';
      input.dataset.index = String(index);
      input.setAttribute('aria-label', fmtHz(hz) + ' Hz gain');
      input.title = fmtHz(hz) + ' Hz';

      var label = document.createElement('span');
      label.className = 'hz';
      label.textContent = fmtHz(hz);

      // Kept for state bookkeeping only; the preview design shows the fader
      // and its frequency, not a per-band number or meter.
      var out = document.createElement('span');
      out.className = 'db';
      out.hidden = true;

      var meter = document.createElement('span');
      meter.className = 'fader-meter';
      meter.hidden = true;

      band.appendChild(input);
      band.appendChild(label);
      band.appendChild(out);
      band.appendChild(meter);
      frag.appendChild(band);

      bandInputs.push(input);
      bandOuts.push(out);
      bandMeters.push(meter);
      bandWraps.push(band);

      input.addEventListener('input', function () {
        out.textContent = fmtBand(parseFloat(input.value) || 0);
        paintBand(index, parseFloat(input.value) || 0);
        onUserChange();
      });
    });

    els.eqBands.appendChild(frag);
  }

  // ---------------------------------------------------------------------------
  // config <-> UI
  // ---------------------------------------------------------------------------

  function readUi() {
    var eq = bandInputs.map(function (input) {
      return parseFloat(input.value) || 0;
    });
    return normalize({
      enabled: els.enabled.checked,
      preampDb: parseFloat(els.preamp.value),
      eq: eq,
      bassDb: parseFloat(els.bass.value),
      airDb: parseFloat(els.air.value),
      width: (parseFloat(els.width.value) || 0) / 100,
      punch: (parseFloat(els.punch.value) || 0) / 100,
      warmth: (parseFloat(els.warmth.value) || 0) / 100,
      reverbMix: (parseFloat(els.mix.value) || 0) / 100,
      reverbDecay: parseFloat(els.decay.value),
      echoMix: (parseFloat(els.echo.value) || 0) / 100
    });
  }

  function render(cfg) {
    var c = normalize(cfg);
    els.enabled.checked = c.enabled;
    els.preamp.value = String(c.preampDb);
    els.bass.value = String(c.bassDb);
    els.air.value = String(c.airDb);
    els.width.value = String(Math.round(c.width * 100));
    els.punch.value = String(Math.round(c.punch * 100));
    els.warmth.value = String(Math.round(c.warmth * 100));
    els.mix.value = String(Math.round(c.reverbMix * 100));
    els.decay.value = String(c.reverbDecay);
    els.echo.value = String(Math.round(c.echoMix * 100));

    for (var b = 0; b < bandInputs.length; b++) {
      bandInputs[b].value = String(c.eq[b]);
      bandOuts[b].textContent = fmtBand(c.eq[b]);
    }

    updateLabels();
    syncChips(matchPreset(c));
  }

  function updateLabels() {
    els.preampOut.textContent = fmtDb(parseFloat(els.preamp.value) || 0);
    els.bassOut.textContent = fmtDb(parseFloat(els.bass.value) || 0);
    els.airOut.textContent = fmtDb(parseFloat(els.air.value) || 0);
    els.widthOut.textContent = Math.round(parseFloat(els.width.value) || 0) + ' %';
    els.punchOut.textContent = Math.round(parseFloat(els.punch.value) || 0) + ' %';
    els.warmthOut.textContent = Math.round(parseFloat(els.warmth.value) || 0) + ' %';
    els.mixOut.textContent = Math.round(parseFloat(els.mix.value) || 0) + ' %';
    els.decayOut.textContent = (Math.round((parseFloat(els.decay.value) || 0) * 10) / 10).toFixed(1) + ' s';
    els.echoOut.textContent = Math.round(parseFloat(els.echo.value) || 0) + ' %';
    els.controls.classList.toggle('off', !els.enabled.checked);
    paintRanges();
  }

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------

  function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (storageBroken) return;
    if (!storageAvailable()) {
      storageBroken = true;
      showNote('chrome.storage is unavailable - settings will not persist.');
      return;
    }
    var payload = {};
    payload[STORAGE_KEY] = readUi();
    try {
      chrome.storage.local.set(payload, function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          storageBroken = true;
          showNote('Could not save settings: ' + chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      storageBroken = true;
      showNote('Could not save settings: ' + (e && e.message ? e.message : e));
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 70);
  }

  function onUserChange() {
    updateLabels();
    syncChips(matchPreset(readUi()));
    scheduleSave();
  }

  function load() {
    if (!storageAvailable()) {
      storageBroken = true;
      showNote('chrome.storage is unavailable - showing defaults.');
      render(DEFAULTS);
      return;
    }
    try {
      chrome.storage.local.get(STORAGE_KEY, function (items) {
        if (chrome.runtime && chrome.runtime.lastError) {
          storageBroken = true;
          showNote('Could not load settings: ' + chrome.runtime.lastError.message);
          render(DEFAULTS);
          return;
        }
        var stored = items && items[STORAGE_KEY];
        render(stored ? normalize(stored) : DEFAULTS);
      });
    } catch (e) {
      storageBroken = true;
      showNote('Could not load settings: ' + (e && e.message ? e.message : e));
      render(DEFAULTS);
    }
  }

  // ---------------------------------------------------------------------------
  // presets / reset
  // ---------------------------------------------------------------------------

  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    var cfg = {
      enabled: els.enabled.checked,
      preampDb: p.preampDb,
      eq: p.eq.slice(),
      bassDb: p.bassDb,
      airDb: p.airDb,
      width: p.width,
      punch: p.punch,
      warmth: p.warmth,
      reverbMix: p.reverbMix,
      reverbDecay: p.reverbDecay,
      echoMix: p.echoMix
    };
    render(cfg);
    saveNow();
  }

  // ---------------------------------------------------------------------------
  // profiles
  // ---------------------------------------------------------------------------

  function renderProfileOptions(selected) {
    if (!els.profileSelect) return;

    var names = Object.keys(profiles).sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });

    els.profileSelect.innerHTML = '';

    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = names.length ? 'Load a profile\u2026' : 'No saved profiles';
    els.profileSelect.appendChild(placeholder);

    if (!names.length) {
      els.profileSelect.disabled = true;
      els.profileDelete.disabled = true;
      return;
    }

    names.forEach(function (name) {
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      els.profileSelect.appendChild(option);
    });

    els.profileSelect.disabled = false;
    els.profileSelect.value = selected && profiles[selected] ? selected : '';
    els.profileDelete.disabled = !profiles[els.profileSelect.value];
  }

  function loadProfiles() {
    if (!storageAvailable()) return;
    try {
      chrome.storage.local.get(PROFILES_KEY, function (items) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        var stored = items && items[PROFILES_KEY];
        profiles = stored && typeof stored === 'object' ? stored : {};
        renderProfileOptions();
      });
    } catch (e) {
      /* profile storage must never break the popup */
    }
  }

  function persistProfiles() {
    if (!storageAvailable()) return;
    try {
      var payload = {};
      payload[PROFILES_KEY] = profiles;
      chrome.storage.local.set(payload, function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          showNote('Could not save profiles: ' + chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      showNote('Could not save profiles: ' + (e && e.message ? e.message : e));
    }
  }

  function openSaveRow() {
    els.profMain.hidden = true;
    els.profSave.hidden = false;
    els.profileName.value = els.profileSelect.value || '';
    els.profileName.focus();
    els.profileName.select();
  }

  function closeSaveRow() {
    els.profSave.hidden = true;
    els.profMain.hidden = false;
  }

  function saveProfile() {
    var name = (els.profileName.value || '').trim();
    if (!name) {
      els.profileName.focus();
      return;
    }

    profiles[name] = readUi();
    persistProfiles();
    closeSaveRow();
    renderProfileOptions(name);
  }

  function disarmDelete() {
    deleteArmed = false;
    if (deleteTimer) {
      clearTimeout(deleteTimer);
      deleteTimer = null;
    }
    if (els.profileDelete) {
      els.profileDelete.textContent = '\u00d7';
      els.profileDelete.classList.remove('armed');
    }
  }

  function deleteSelectedProfile() {
    var name = els.profileSelect.value;
    if (!name || !profiles[name]) return;
    delete profiles[name];
    persistProfiles();
    disarmDelete();
    renderProfileOptions();
  }

  function onDeleteClick() {
    if (els.profileSelect.disabled || !els.profileSelect.value) return;

    if (deleteArmed) {
      deleteSelectedProfile();
      return;
    }

    deleteArmed = true;
    els.profileDelete.textContent = 'Sure?';
    els.profileDelete.classList.add('armed');
    deleteTimer = setTimeout(disarmDelete, 2600);
  }

  // ---------------------------------------------------------------------------
  // tab check + wiring
  // ---------------------------------------------------------------------------

  /** Focus an open YouTube Music tab, or open one. Used by the CTA shown when
      the active tab is not YouTube Music. */
  function openYouTubeMusic() {
    function done() {
      try {
        window.close();
      } catch (e) {
        /* ignore */
      }
    }

    try {
      chrome.tabs.query({ url: 'https://music.youtube.com/*' }, function (tabs) {
        var tab = tabs && tabs[0];
        if (tab && tab.id !== undefined) {
          chrome.tabs.update(tab.id, { active: true });
          if (tab.windowId !== undefined && chrome.windows && chrome.windows.update) {
            chrome.windows.update(tab.windowId, { focused: true });
          }
        } else {
          chrome.tabs.create({ url: 'https://music.youtube.com/' });
        }
        done();
      });
    } catch (e) {
      try {
        chrome.tabs.create({ url: 'https://music.youtube.com/' });
      } catch (e2) {
        /* ignore */
      }
      done();
    }
  }

  /** Warn when the content script is not live in the active tab (fresh install,
      reload needed, or the tab predates the extension). */
  function checkActiveTab() {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        var isYtm = !!(tab && /^https:\/\/music\.youtube\.com\//.test(tab.url || ''));
        if (!isYtm) {
          setTransportEnabled(false);
          showNote('Effects live on YouTube Music.', 'Open YouTube Music', openYouTubeMusic);
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: 'YTMSE_PING' }, function (response) {
          if (chrome.runtime.lastError || !response || !response.ok) {
            setTransportEnabled(false);
            showNote('Reload the YouTube Music tab to activate the effects.', 'Reload tab', function () {
              chrome.tabs.reload(tab.id);
              window.close();
            });
            return;
          }
          hideTabNote();
          transport.tabId = tab.id;
          setTransportEnabled(true);
          startViz(tab.id);
        });
      });
    } catch (e) {
      /* ignore */
    }
  }

  function collect() {
    els.enabled = document.getElementById('enabled');
    els.note = document.getElementById('note');
    els.noteText = document.getElementById('noteText');
    els.noteAction = document.getElementById('noteAction');
    els.controls = document.getElementById('controls');
    els.eqStage = document.querySelector('.eq-stage');
    els.eqBands = document.getElementById('eqBands');
    els.preamp = document.getElementById('preamp');
    els.preampOut = document.getElementById('preampOut');
    els.bass = document.getElementById('bass');
    els.bassOut = document.getElementById('bassOut');
    els.air = document.getElementById('air');
    els.airOut = document.getElementById('airOut');
    els.width = document.getElementById('width');
    els.widthOut = document.getElementById('widthOut');
    els.punch = document.getElementById('punch');
    els.punchOut = document.getElementById('punchOut');
    els.warmth = document.getElementById('warmth');
    els.warmthOut = document.getElementById('warmthOut');
    els.mix = document.getElementById('mix');
    els.mixOut = document.getElementById('mixOut');
    els.decay = document.getElementById('decay');
    els.decayOut = document.getElementById('decayOut');
    els.echo = document.getElementById('echo');
    els.echoOut = document.getElementById('echoOut');
    els.reset = document.getElementById('reset');
    els.player = document.getElementById('player');
    els.prevBtn = document.getElementById('prevBtn');
    els.playBtn = document.getElementById('playBtn');
    els.nextBtn = document.getElementById('nextBtn');
    els.shuffleBtn = document.getElementById('shuffleBtn');
    els.progress = document.getElementById('progress');
    els.progressRail = els.progress ? els.progress.querySelector('.progress-rail') : null;
    els.progressFill = document.getElementById('progressFill');
    els.progressHead = document.getElementById('progressHead');
    els.curTime = document.getElementById('curTime');
    els.durTime = document.getElementById('durTime');
    els.vizCanvas = document.getElementById('viz');
    els.profMain = document.getElementById('profMain');
    els.profSave = document.getElementById('profSave');
    els.profileSelect = document.getElementById('profileSelect');
    els.profileName = document.getElementById('profileName');
    els.profileSave = document.getElementById('profileSave');
    els.profileCancel = document.getElementById('profileCancel');
    els.profileSaveStart = document.getElementById('profileSaveStart');
    els.profileDelete = document.getElementById('profileDelete');
  }

  function init() {
    collect();
    buildEq();
    render(DEFAULTS);
    setTransportEnabled(false);
    transport.baseAt = performance.now();
    transport.raf = window.requestAnimationFrame(progressTick);

    viz.canvas = els.vizCanvas;
    viz.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    fitViz();
    window.addEventListener('resize', function () {
      fitViz();
      drawSpectrum();
    });
    if (typeof ResizeObserver === 'function' && els.eqStage) {
      new ResizeObserver(function () {
        fitViz();
        drawSpectrum();
      }).observe(els.eqStage);
    }

    ['preamp', 'bass', 'air', 'width', 'punch', 'warmth', 'mix', 'decay', 'echo'].forEach(function (key) {
      els[key].addEventListener('input', onUserChange);
    });

    els.enabled.addEventListener('change', onUserChange);

    els.playBtn.addEventListener('click', function () {
      if (!transport.enabled) return;
      var nextPaused = !transport.paused;
      transport.baseTime = transport.shown;
      transport.baseAt = performance.now();
      transport.holdUntil = transport.baseAt + 550;
      applyPlayState(nextPaused);
      sendCommand('playpause');
    });

    els.prevBtn.addEventListener('click', function () {
      sendCommand('prev');
    });

    els.nextBtn.addEventListener('click', function () {
      sendCommand('next');
    });

    els.shuffleBtn.addEventListener('click', function () {
      if (!transport.enabled) return;
      transport.holdUntil = performance.now() + 700;
      applyShuffle(transport.shuffle !== true);
      sendCommand('shuffle');
    });

    if (els.progress) {
      var finishSeek = function (event, commit) {
        if (!transport.dragging) return;
        transport.dragging = false;
        els.progress.classList.remove('is-seeking');
        if (els.progress.hasPointerCapture && event.pointerId != null) {
          try {
            if (els.progress.hasPointerCapture(event.pointerId)) {
              els.progress.releasePointerCapture(event.pointerId);
            }
          } catch (e) {
            /* ignore */
          }
        }
        if (commit) {
          // Only retarget when the pointer is still over the rail. Releasing
          // outside commits the last preview instead of jumping to 0 or 100%.
          var rail = els.progressRail || els.progress;
          var rect = rail.getBoundingClientRect();
          var inside = isFinite(event.clientX) &&
            event.clientX >= rect.left - 1 && event.clientX <= rect.right + 1;
          if (inside) previewSeek(seekFraction(event.clientX));
          commitSeek();
        } else {
          transport.baseTime = transport.shown;
          transport.baseAt = performance.now();
        }
      };

      els.progress.addEventListener('pointerdown', function (event) {
        if (!transport.enabled || !(transport.duration > 0)) return;
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        transport.dragging = true;
        transport.lastSeekAt = 0;
        els.progress.classList.add('is-seeking');
        if (els.progress.setPointerCapture) {
          try {
            els.progress.setPointerCapture(event.pointerId);
          } catch (e) {
            /* ignore */
          }
        }
        previewSeek(seekFraction(event.clientX));
      });

      els.progress.addEventListener('pointermove', function (event) {
        if (!transport.dragging) return;
        previewSeek(seekFraction(event.clientX), true);
      });

      els.progress.addEventListener('pointerup', function (event) {
        finishSeek(event, true);
      });

      els.progress.addEventListener('pointercancel', function (event) {
        finishSeek(event, false);
      });

      // Pointer capture can fail or be cancelled when the popup loses focus.
      // A document-level release still commits the last previewed position.
      var releaseOutside = function (event) {
        if (!transport.dragging) return;
        if (els.progress.contains(event.target)) return;
        finishSeek(event, event.type === 'pointerup');
      };
      document.addEventListener('pointerup', releaseOutside);
      document.addEventListener('pointercancel', releaseOutside);

      els.progress.addEventListener('keydown', function (event) {
        if (!transport.enabled || !(transport.duration > 0)) return;
        var step = event.shiftKey ? 30 : 5;
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault();
          seekBy(step);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          event.preventDefault();
          seekBy(-step);
        } else if (event.key === 'Home') {
          event.preventDefault();
          transport.shown = 0;
          commitSeek();
        } else if (event.key === 'End') {
          event.preventDefault();
          transport.shown = transport.duration;
          commitSeek();
        }
      });
    }

    var chips = document.querySelectorAll('.chip[data-preset]');
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener('click', function () {
        applyPreset(this.dataset.preset);
      });
    }

    els.reset.addEventListener('click', function () {
      render(DEFAULTS);
      saveNow();
    });

    els.profileSaveStart.addEventListener('click', openSaveRow);
    els.profileCancel.addEventListener('click', closeSaveRow);
    els.profileSave.addEventListener('click', saveProfile);
    els.profileDelete.addEventListener('click', onDeleteClick);

    els.profileSelect.addEventListener('change', function () {
      var cfg = profiles[this.value];
      els.profileDelete.disabled = !cfg;
      if (!cfg) return;
      render(normalize(cfg));
      saveNow();
    });

    els.profileName.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveProfile();
      } else if (event.key === 'Escape') {
        closeSaveRow();
      }
    });

    load();
    loadProfiles();
    checkActiveTab();
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  } catch (e) {
    showNote('Popup failed to initialise: ' + (e && e.message ? e.message : e));
  }
})();
