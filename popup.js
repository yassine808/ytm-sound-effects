/*
 * YTM Sound Effects - popup UI.
 * Reads/writes chrome.storage.local["ytmse:config"]; the content script applies
 * changes live and streams analyser frames for the spectrum graph.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'ytmse:config';
  var BARS = 56;
  var FRAME_MS = 90;

  var api = window.YTMAudio;
  var BANDS = (api && api.BANDS) || [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  var DEFAULTS = api && api.defaultConfig
    ? api.defaultConfig()
    : { enabled: true, preampDb: 0, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bassDb: 0, reverbMix: 0, reverbDecay: 1.8 };
  var normalize = api && api.normalizeConfig ? api.normalizeConfig : function (c) { return c || DEFAULTS; };

  // Hardcoded presets. eq is the 10-band gain array (dB), in BANDS order.
  var PRESETS = {
    Flat: { preampDb: 0, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bassDb: 0, reverbMix: 0, reverbDecay: 1.8 },
    Bass: { preampDb: -2, eq: [6, 5.5, 3, 1, 0, -1, -1, 0.5, 1, 1], bassDb: 8, reverbMix: 0.05, reverbDecay: 1.2 },
    Vocal: { preampDb: 0, eq: [-3, -2, -1, 1, 3, 4, 3, 1.5, 0, -1], bassDb: 0, reverbMix: 0.12, reverbDecay: 1.0 },
    Live: { preampDb: -1, eq: [2.5, 2, 1, 0, -1.5, 0, 1, 2, 2, 2], bassDb: 3, reverbMix: 0.3, reverbDecay: 1.7 },
    Hall: { preampDb: -2, eq: [1.5, 1, 0, -1, -1, 0, 1, 1, 0, 0.5], bassDb: 2, reverbMix: 0.45, reverbDecay: 3.2 }
  };

  var els = {};
  var bandInputs = [];
  var bandOuts = [];
  var bandMeters = [];
  var bandWraps = [];
  var bandLive = [];
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
    timer: null,
    busy: false,
    fails: 0,
    reduced: false
  };
  var smoothBars = new Array(BARS);
  var smoothBands = new Array(BANDS.length);
  var i;
  for (i = 0; i < BARS; i++) smoothBars[i] = 0;
  for (i = 0; i < smoothBands.length; i++) smoothBands[i] = 0;

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

  function paintRange(el, pct) {
    if (!el) return;
    var clamped = Math.max(0, Math.min(100, pct));
    el.style.setProperty('--p', clamped + '%');
  }

  function paintRanges() {
    paintRange(els.preamp, ((parseFloat(els.preamp.value) || 0) + 12) / 24 * 100);
    paintRange(els.bass, (parseFloat(els.bass.value) || 0) / 15 * 100);
    paintRange(els.mix, parseFloat(els.mix.value) || 0);
    paintRange(els.decay, ((parseFloat(els.decay.value) || 1.8) - 0.3) / 3.7 * 100);

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
      if (Math.abs(p.reverbMix - cfg.reverbMix) > EPS) continue;
      if (Math.abs(p.reverbDecay - cfg.reverbDecay) > EPS) continue;

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
  // live spectrum (canvas behind the UI + the EQ meters)
  // ---------------------------------------------------------------------------

  function fitViz() {
    if (!viz.canvas) return;
    var dpr = window.devicePixelRatio || 1;
    viz.w = Math.max(1, window.innerWidth);
    viz.h = Math.max(1, window.innerHeight);
    viz.canvas.width = Math.round(viz.w * dpr);
    viz.canvas.height = Math.round(viz.h * dpr);
    viz.canvas.style.width = viz.w + 'px';
    viz.canvas.style.height = viz.h + 'px';
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
    var barWidth = (w - gap * (BARS - 1)) / BARS;
    var gradient = ctx.createLinearGradient(0, h, 0, h * 0.18);
    gradient.addColorStop(0, 'rgba(255, 45, 45, 0.55)');
    gradient.addColorStop(0.55, 'rgba(255, 80, 80, 0.22)');
    gradient.addColorStop(1, 'rgba(255, 120, 120, 0)');
    ctx.fillStyle = gradient;

    for (var b = 0; b < BARS; b++) {
      var v = smoothBars[b];
      if (v <= 0.001) continue;
      var bh = Math.max(1, Math.pow(v, 0.8) * h * 0.92);
      ctx.fillRect(b * (barWidth + gap), h - bh, barWidth, bh);
    }
  }

  function renderFrame(res) {
    var b;
    for (b = 0; b < BARS; b++) {
      var rawBar = res.bars && typeof res.bars[b] === 'number' ? res.bars[b] : 0;
      var target = Math.min(1, Math.pow(rawBar, 0.7) * 1.15);
      smoothBars[b] += (target - smoothBars[b]) * 0.45;
    }

    for (b = 0; b < bandLive.length; b++) {
      var rawBand = res.bands && typeof res.bands[b] === 'number' ? res.bands[b] : 0;
      var bandTarget = Math.min(1, Math.pow(rawBand, 0.7) * 1.35);
      smoothBands[b] += (bandTarget - smoothBands[b]) * 0.45;
      if (bandLive[b]) {
        bandLive[b].style.transform =
          'translateX(-50%) scaleY(' + smoothBands[b].toFixed(3) + ')';
      }
    }

    drawSpectrum();
  }

  function requestFrame(tabId) {
    viz.busy = true;
    try {
      chrome.tabs.sendMessage(tabId, { type: 'YTMSE_FRAME' }, function (res) {
        viz.busy = false;
        if (chrome.runtime.lastError || !res || res.ok !== true) {
          viz.fails += 1;
          if (viz.fails > 4) stopViz();
          return;
        }
        viz.fails = 0;
        renderFrame(res);
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

      var out = document.createElement('span');
      out.className = 'db';
      out.textContent = '0';

      var fader = document.createElement('div');
      fader.className = 'fader';

      var rail = document.createElement('span');
      rail.className = 'fader-rail';

      var zero = document.createElement('span');
      zero.className = 'fader-zero';

      var meter = document.createElement('span');
      meter.className = 'fader-meter';

      var live = document.createElement('span');
      live.className = 'fader-live';
      live.setAttribute('aria-hidden', 'true');

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

      fader.appendChild(rail);
      fader.appendChild(zero);
      fader.appendChild(live);
      fader.appendChild(meter);
      fader.appendChild(input);

      var label = document.createElement('span');
      label.className = 'hz';
      label.textContent = fmtHz(hz);

      band.appendChild(out);
      band.appendChild(fader);
      band.appendChild(label);
      frag.appendChild(band);

      bandInputs.push(input);
      bandOuts.push(out);
      bandMeters.push(meter);
      bandWraps.push(band);
      bandLive.push(live);

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
      reverbMix: (parseFloat(els.mix.value) || 0) / 100,
      reverbDecay: parseFloat(els.decay.value)
    });
  }

  function render(cfg) {
    var c = normalize(cfg);
    els.enabled.checked = c.enabled;
    els.preamp.value = String(c.preampDb);
    els.bass.value = String(c.bassDb);
    els.mix.value = String(Math.round(c.reverbMix * 100));
    els.decay.value = String(c.reverbDecay);

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
    els.mixOut.textContent = Math.round(parseFloat(els.mix.value) || 0) + ' %';
    els.decayOut.textContent = (Math.round((parseFloat(els.decay.value) || 0) * 10) / 10).toFixed(1) + ' s';
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
      reverbMix: p.reverbMix,
      reverbDecay: p.reverbDecay
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

  /** Warn when the content script is not live in the active tab (fresh install,
      reload needed, or the tab predates the extension). */
  function checkActiveTab() {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        var isYtm = !!(tab && /^https:\/\/music\.youtube\.com\//.test(tab.url || ''));
        if (!isYtm) {
          showNote('Open a YouTube Music tab to use the effects.');
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: 'YTMSE_PING' }, function (response) {
          if (chrome.runtime.lastError || !response || !response.ok) {
            showNote('Reload the YouTube Music tab to activate the effects.', 'Reload tab', function () {
              chrome.tabs.reload(tab.id);
              window.close();
            });
            return;
          }
          hideTabNote();
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
    els.eqBands = document.getElementById('eqBands');
    els.preamp = document.getElementById('preamp');
    els.preampOut = document.getElementById('preampOut');
    els.bass = document.getElementById('bass');
    els.bassOut = document.getElementById('bassOut');
    els.mix = document.getElementById('mix');
    els.mixOut = document.getElementById('mixOut');
    els.decay = document.getElementById('decay');
    els.decayOut = document.getElementById('decayOut');
    els.reset = document.getElementById('reset');
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

    viz.canvas = els.vizCanvas;
    viz.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    fitViz();
    window.addEventListener('resize', function () {
      fitViz();
      drawSpectrum();
    });

    ['preamp', 'bass', 'mix', 'decay'].forEach(function (key) {
      els[key].addEventListener('input', onUserChange);
    });

    els.enabled.addEventListener('change', onUserChange);

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
