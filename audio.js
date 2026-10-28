/*
 * YTM Sound Effects — audio graph (pure Web Audio, no chrome.* APIs).
 *
 *   <video> --source--> preamp --> EQ x10 --> bass shelf --+--> dry ----+
 *                                                          +--> conv --> wet --> limiter --> destination
 *
 * Exposes: window.YTMAudio = { SoundChain, defaultConfig, normalizeConfig, DEFAULTS, BANDS }
 */
(function () {
  'use strict';

  var BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  var EQ_Q = 1.1;
  var BASS_FREQ = 100;
  var RAMP = 0.02; // smoothing time constant (s)
  var DECAY_EPSILON = 0.05; // seconds; below this we reuse the current IR

  var LIMITER = { threshold: -1, ratio: 20, knee: 0, attack: 0.003, release: 0.25 };

  // ---------------------------------------------------------------------------
  // config helpers
  // ---------------------------------------------------------------------------

  function defaultConfig() {
    return {
      enabled: true,
      preampDb: 0,
      eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      bassDb: 0,
      reverbMix: 0,
      reverbDecay: 1.8
    };
  }

  function num(value, fallback, min, max) {
    var n = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /** Coerce anything from storage/UI into a valid config. Never throws. */
  function normalizeConfig(raw) {
    var base = defaultConfig();
    if (!raw || typeof raw !== 'object') return base;

    var out = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
      preampDb: num(raw.preampDb, base.preampDb, -12, 12),
      eq: base.eq.slice(),
      bassDb: num(raw.bassDb, base.bassDb, 0, 15),
      reverbMix: num(raw.reverbMix, base.reverbMix, 0, 1),
      reverbDecay: num(raw.reverbDecay, base.reverbDecay, 0.3, 4)
    };

    if (Array.isArray(raw.eq)) {
      for (var i = 0; i < base.eq.length; i++) {
        out.eq[i] = num(raw.eq[i], 0, -12, 12);
      }
    }
    return out;
  }

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  // ---------------------------------------------------------------------------
  // one shared AudioContext + one MediaElementSource per element (hard browser limit)
  // ---------------------------------------------------------------------------

  var sharedContext = null;

  // element -> { context, source, chain }
  var elementCache = new WeakMap();

  function getContext() {
    if (sharedContext) return sharedContext;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API is not available in this document.');
    sharedContext = new Ctor({ latencyHint: 'playback' });
    return sharedContext;
  }

  function disconnectQuietly(node) {
    try {
      if (node) node.disconnect();
    } catch (e) {
      /* already disconnected — ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // SoundChain
  // ---------------------------------------------------------------------------

  /**
   * @param {HTMLVideoElement|HTMLAudioElement} element media element to process.
   */
  function SoundChain(element) {
    if (!element) throw new Error('SoundChain requires a media element.');

    var cached = elementCache.get(element);

    // A previous chain for this same element would double the audio — tear it down.
    if (cached && cached.chain) {
      try {
        cached.chain.dispose();
      } catch (e) {
        /* ignore */
      }
    }

    var ctx = cached ? cached.context : getContext();
    var source = cached ? cached.source : null;

    if (!source) {
      try {
        source = ctx.createMediaElementSource(element);
      } catch (err) {
        var isInvalidState = err && (err.name === 'InvalidStateError' || err.code === 11);
        SoundChain.lastError = isInvalidState
          ? 'This media element is already owned by another AudioContext ' +
            '(another extension probably created a MediaElementSource for it). ' +
            'Disable the other audio extension and reload the page.'
          : 'createMediaElementSource failed: ' + (err && err.message ? err.message : String(err));
        console.warn('[YTM Sound Effects] ' + SoundChain.lastError);
        throw err;
      }
      elementCache.set(element, { context: ctx, source: source, chain: null });
    }

    if (ctx.state === 'suspended') {
      // Async by policy; the page gesture handler resumes it. Don't await here.
      try {
        var p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {
        /* ignore */
      }
    }

    this.element = element;
    this.context = ctx;
    this.source = source;
    this.disposed = false;
    this._config = defaultConfig();
    this._impulseDecay = -1;
    this._ramp = RAMP;

    this._build();

    // Re-register so a rebuilt chain is the one torn down next time.
    elementCache.set(element, { context: ctx, source: source, chain: this });
  }

  SoundChain.lastError = null;
  SoundChain.BANDS = BANDS.slice();
  SoundChain.resumeContext = function () {
    if (!sharedContext) return Promise.resolve(false);
    if (sharedContext.state === 'running') return Promise.resolve(true);
    return sharedContext.resume().then(
      function () { return sharedContext.state === 'running'; },
      function () { return false; }
    );
  };
  SoundChain.getContext = function () {
    try {
      return getContext();
    } catch (e) {
      return null;
    }
  };

  SoundChain.prototype._build = function () {
    var ctx = this.context;

    this.preamp = ctx.createGain();
    this.preamp.gain.value = 1;

    this.eq = [];
    for (var i = 0; i < BANDS.length; i++) {
      var filter = ctx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = BANDS[i];
      filter.Q.value = EQ_Q;
      filter.gain.value = 0;
      this.eq.push(filter);
    }

    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = BASS_FREQ;
    this.bass.gain.value = 0;

    this.dry = ctx.createGain();
    this.dry.gain.value = 1;

    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;

    this.wet = ctx.createGain();
    this.wet.gain.value = 0;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMITER.threshold;
    this.limiter.ratio.value = LIMITER.ratio;
    this.limiter.knee.value = LIMITER.knee;
    this.limiter.attack.value = LIMITER.attack;
    this.limiter.release.value = LIMITER.release;

    // Post-chain analyser: lets the extension (and tests) verify that samples
    // actually reach the destination instead of failing silently.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this._levelBuffer = new Float32Array(this.analyser.fftSize);

    // --- wiring: source -> preamp -> eq[0..9] -> bass -> {dry, convolver->wet} -> limiter -> destination
    this.source.connect(this.preamp);

    var node = this.preamp;
    for (var j = 0; j < this.eq.length; j++) {
      node.connect(this.eq[j]);
      node = this.eq[j];
    }
    node.connect(this.bass);

    this.bass.connect(this.dry);
    this.bass.connect(this.convolver);
    this.convolver.connect(this.wet);

    this.dry.connect(this.limiter);
    this.wet.connect(this.limiter);

    this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this._impulseDecay = -1;
    this._setImpulse(this._config.reverbDecay);
  };

  /** Regenerate the synthetic IR only when the decay length really changed. */
  SoundChain.prototype._setImpulse = function (decay) {
    if (Math.abs(decay - this._impulseDecay) <= DECAY_EPSILON && this.convolver.buffer) return;
    try {
      this.convolver.buffer = buildImpulse(this.context, decay);
      this._impulseDecay = decay;
    } catch (e) {
      console.warn('[YTM Sound Effects] Could not build reverb impulse:', e);
    }
  };

  /** Apply a (partial) config. Ramps everything; bypass is neutral, never disconnects. */
  SoundChain.prototype.setConfig = function (raw) {
    if (this.disposed) return;
    var cfg = normalizeConfig(raw);
    this._config = cfg;

    var now = this.context.currentTime;
    var on = cfg.enabled;

    // master
    this._rampParam(this.preamp.gain, on ? dbToGain(cfg.preampDb) : 1, now);

    // EQ
    for (var i = 0; i < this.eq.length; i++) {
      this._rampParam(this.eq[i].gain, on ? cfg.eq[i] : 0, now);
    }

    // bass shelf
    this._rampParam(this.bass.gain, on ? cfg.bassDb : 0, now);

    // reverb wet/dry crossfade
    var mix = on ? cfg.reverbMix : 0;
    if (mix > 0) this._setImpulse(cfg.reverbDecay);
    this._rampParam(this.dry.gain, 1 - mix, now);
    this._rampParam(this.wet.gain, mix, now);

    // limiter stays in the path in every mode (it is transparent below -1 dBFS).
  };

  SoundChain.prototype._rampParam = function (param, value, now) {
    try {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, this._ramp);
    } catch (e) {
      try {
        param.value = value;
      } catch (e2) {
        /* ignore */
      }
    }
  };

  SoundChain.prototype.getConfig = function () {
    var c = this._config;
    return {
      enabled: c.enabled,
      preampDb: c.preampDb,
      eq: c.eq.slice(),
      bassDb: c.bassDb,
      reverbMix: c.reverbMix,
      reverbDecay: c.reverbDecay
    };
  };

  SoundChain.prototype.resume = function () {
    var ctx = this.context;
    if (ctx.state === 'running') return Promise.resolve(true);
    return ctx.resume().then(
      function () { return ctx.state === 'running'; },
      function () { return false; }
    );
  };

  /** RMS of the post-limiter signal (0..1). 0 while nothing is playing. */
  SoundChain.prototype.getLevel = function () {
    if (this.disposed || !this.analyser) return 0;
    try {
      this.analyser.getFloatTimeDomainData(this._levelBuffer);
      var sum = 0;
      for (var i = 0; i < this._levelBuffer.length; i++) {
        sum += this._levelBuffer[i] * this._levelBuffer[i];
      }
      return Math.sqrt(sum / this._levelBuffer.length);
    } catch (e) {
      return 0;
    }
  };

  /** Disconnect this chain's nodes. The MediaElementSource is kept alive (browser limit). */
  SoundChain.prototype.dispose = function () {
    if (this.disposed) return;
    this.disposed = true;

    disconnectQuietly(this.source);
    disconnectQuietly(this.preamp);
    for (var i = 0; i < this.eq.length; i++) disconnectQuietly(this.eq[i]);
    disconnectQuietly(this.bass);
    disconnectQuietly(this.dry);
    disconnectQuietly(this.convolver);
    disconnectQuietly(this.wet);
    disconnectQuietly(this.limiter);
    disconnectQuietly(this.analyser);

    try {
      this.convolver.buffer = null;
    } catch (e) {
      /* ignore */
    }
  };

  // ---------------------------------------------------------------------------
  // synthetic impulse response (stereo decaying noise)
  // ---------------------------------------------------------------------------

  function buildImpulse(ctx, decay) {
    var sampleRate = ctx.sampleRate || 44100;
    var length = Math.max(1, Math.floor(sampleRate * decay));
    var buffer = ctx.createBuffer(2, length, sampleRate);
    var fadeIn = Math.max(1, Math.floor(sampleRate * 0.004));

    for (var ch = 0; ch < 2; ch++) {
      var data = buffer.getChannelData(ch);
      var smooth = 0;
      // independent noise per channel => natural stereo decorrelation
      for (var i = 0; i < length; i++) {
        var t = i / sampleRate;
        var env = Math.exp((-6.9 * t) / decay); // ~ -60 dB at the tail
        smooth = 0.6 * smooth + 0.4 * (Math.random() * 2 - 1);
        var fade = i < fadeIn ? i / fadeIn : 1;
        data[i] = smooth * env * fade;
      }
    }
    return buffer;
  }

  // ---------------------------------------------------------------------------

  window.YTMAudio = {
    SoundChain: SoundChain,
    BANDS: BANDS.slice(),
    DEFAULTS: defaultConfig(),
    defaultConfig: defaultConfig,
    normalizeConfig: normalizeConfig,
    dbToGain: dbToGain
  };
})();
