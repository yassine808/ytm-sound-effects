/*
 * YTM Sound Effects — audio graph (pure Web Audio, no chrome.* APIs).
 *
 *   <video> -> source -> preamp -> EQ x10 -> bass -> air -> width
 *           -> warmth -> punch -> +-> dry ------------------------+
 *                                +-> convolver -> reverb wet -----+-> limiter
 *                                +-> delay -> echo wet ----------+   -> master
 *                                                                    -> analyser
 *                                                                    -> destination
 *
 * Exposes: window.YTMAudio = { SoundChain, defaultConfig, normalizeConfig, DEFAULTS, BANDS }
 */
(function () {
  'use strict';

  var BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  var EQ_Q = 1.1;
  var BASS_FREQ = 100;
  var AIR_FREQ = 4200;
  var ECHO_TIME = 0.28;
  var ECHO_FEEDBACK = 0.34;
  var ECHO_TONE_HZ = 3200;
  var SATURATION_DRIVE = 2.5;
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
      airDb: 0,
      width: 1,
      punch: 0,
      warmth: 0,
      reverbMix: 0,
      reverbDecay: 1.8,
      echoMix: 0
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
      airDb: num(raw.airDb, base.airDb, -12, 12),
      width: num(raw.width, base.width, 0, 2),
      punch: num(raw.punch, base.punch, 0, 1),
      warmth: num(raw.warmth, base.warmth, 0, 1),
      reverbMix: num(raw.reverbMix, base.reverbMix, 0, 1),
      reverbDecay: num(raw.reverbDecay, base.reverbDecay, 0.3, 4),
      echoMix: num(raw.echoMix, base.echoMix, 0, 1)
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

    // Air: a high shelf, so the top end can be opened up without editing bands.
    this.air = ctx.createBiquadFilter();
    this.air.type = 'highshelf';
    this.air.frequency.value = AIR_FREQ;
    this.air.gain.value = 0;

    // Stereo width as a mid/side matrix. width = 1 reconstructs L/R exactly;
    // 0 collapses to mono, 2 stretches the sides.
    this._widthNodes = [];
    var split = ctx.createChannelSplitter(2);
    var merge = ctx.createChannelMerger(2);
    var mid = ctx.createGain();
    var side = ctx.createGain();
    var midL = ctx.createGain();
    var midR = ctx.createGain();
    var sideL = ctx.createGain();
    var sideR = ctx.createGain();
    this._widthSideL = ctx.createGain();
    this._widthSideR = ctx.createGain();
    midL.gain.value = 0.5;
    midR.gain.value = 0.5;
    sideL.gain.value = 0.5;
    sideR.gain.value = -0.5;
    this._widthSideL.gain.value = 1;
    this._widthSideR.gain.value = -1;
    this._widthNodes.push(
      split, merge, mid, side, midL, midR, sideL, sideR,
      this._widthSideL, this._widthSideR
    );

    // Warmth: parallel soft saturation. The dry path stays clean, the wet path
    // only adds harmonics, and 0 is fully neutral.
    this.warmDry = ctx.createGain();
    this.warmWet = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = buildSaturationCurve(SATURATION_DRIVE);
    this.shaper.oversample = '2x';
    this.warmDry.gain.value = 1;
    this.warmWet.gain.value = 0;

    // Punch: gentle bus compression with makeup, 0 = transparent ratio of 1.
    this.punch = ctx.createDynamicsCompressor();
    this.punch.threshold.value = -6;
    this.punch.knee.value = 6;
    this.punch.ratio.value = 1;
    this.punch.attack.value = 0.006;
    this.punch.release.value = 0.18;

    this.punchMakeup = ctx.createGain();
    this.punchMakeup.gain.value = 1;

    // Echo: a single warm tap with a short feedback tail.
    this.echoDelay = ctx.createDelay(1);
    this.echoDelay.delayTime.value = ECHO_TIME;
    this.echoTone = ctx.createBiquadFilter();
    this.echoTone.type = 'lowpass';
    this.echoTone.frequency.value = ECHO_TONE_HZ;
    this.echoTone.Q.value = 0.7;
    this.echoFeedback = ctx.createGain();
    this.echoFeedback.gain.value = ECHO_FEEDBACK;
    this.echoWet = ctx.createGain();
    this.echoWet.gain.value = 0;

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

    // Master mute, used for ads. Kept inside the chain so the page's own
    // volume/mute state is never modified.
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this._adMuted = false;

    // Post-chain analyser: lets the extension (and tests) verify that samples
    // actually reach the destination instead of failing silently.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this._levelBuffer = new Float32Array(this.analyser.fftSize);
    this._spectrumBuffer = null;

    // --- wiring:
    // source -> preamp -> eq[0..9] -> bass -> air -> width (M/S)
    //   -> warmth (dry + saturated) -> punch -> {dry, convolver->wet, echo}
    //   -> limiter -> master -> analyser -> destination
    this.source.connect(this.preamp);

    var node = this.preamp;
    for (var j = 0; j < this.eq.length; j++) {
      node.connect(this.eq[j]);
      node = this.eq[j];
    }
    node.connect(this.bass);
    this.bass.connect(this.air);
    this.air.connect(split);

    split.connect(midL, 0);
    midL.connect(mid);
    split.connect(midR, 1);
    midR.connect(mid);
    split.connect(sideL, 0);
    sideL.connect(side);
    split.connect(sideR, 1);
    sideR.connect(side);
    mid.connect(merge, 0);
    mid.connect(merge, 1);
    side.connect(this._widthSideL);
    this._widthSideL.connect(merge, 0);
    side.connect(this._widthSideR);
    this._widthSideR.connect(merge, 1);

    merge.connect(this.warmDry);
    merge.connect(this.shaper);
    this.shaper.connect(this.warmWet);
    this.warmDry.connect(this.punch);
    this.warmWet.connect(this.punch);

    this.punch.connect(this.punchMakeup);
    this.punchMakeup.connect(this.dry);
    this.punchMakeup.connect(this.convolver);
    this.punchMakeup.connect(this.echoDelay);

    this.convolver.connect(this.wet);

    this.echoDelay.connect(this.echoTone);
    this.echoTone.connect(this.echoFeedback);
    this.echoFeedback.connect(this.echoDelay);
    this.echoTone.connect(this.echoWet);

    this.dry.connect(this.limiter);
    this.wet.connect(this.limiter);
    this.echoWet.connect(this.limiter);

    this.limiter.connect(this.master);
    this.master.connect(this.analyser);
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

    // bass + air shelves
    this._rampParam(this.bass.gain, on ? cfg.bassDb : 0, now);
    this._rampParam(this.air.gain, on ? cfg.airDb : 0, now);

    // stereo width: 1 = neutral, 0 = mono, 2 = wide
    var width = on ? cfg.width : 1;
    this._rampParam(this._widthSideL.gain, width, now);
    this._rampParam(this._widthSideR.gain, -width, now);

    // warmth: parallel saturated path
    var warmth = on ? cfg.warmth : 0;
    this._rampParam(this.warmDry.gain, 1 - warmth * 0.1, now);
    this._rampParam(this.warmWet.gain, warmth * 0.18, now);

    // punch compressor
    var punch = on ? cfg.punch : 0;
    this._rampParam(this.punch.threshold, -6 - 24 * punch, now);
    this._rampParam(this.punch.ratio, 1 + 5 * punch, now);
    this._rampParam(this.punchMakeup.gain, dbToGain(punch * 6), now);

    // echo send
    var echo = on ? cfg.echoMix : 0;
    this._rampParam(this.echoWet.gain, echo * 0.5, now);

    // reverb wet/dry crossfade
    var mix = on ? cfg.reverbMix : 0;
    if (mix > 0) this._setImpulse(cfg.reverbDecay);
    this._rampParam(this.dry.gain, 1 - mix, now);
    this._rampParam(this.wet.gain, mix, now);

    // limiter stays in the path in every mode (it is transparent below -1 dBFS).
  };

  /** Silence the chain (ads) without touching the site's volume/mute state. */
  SoundChain.prototype.setMuted = function (muted) {
    if (this.disposed || !this.master) return;
    this._adMuted = !!muted;
    this._rampParam(this.master.gain, muted ? 0 : 1, this.context.currentTime);
  };

  SoundChain.prototype.isMuted = function () {
    return !!this._adMuted;
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
      airDb: c.airDb,
      width: c.width,
      punch: c.punch,
      warmth: c.warmth,
      reverbMix: c.reverbMix,
      reverbDecay: c.reverbDecay,
      echoMix: c.echoMix
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

  /** Frequency magnitudes (0..255 per bin) for the popup's spectrum graph. */
  SoundChain.prototype.getSpectrum = function () {
    if (this.disposed || !this.analyser) return null;
    try {
      var bins = this.analyser.frequencyBinCount;
      if (!this._spectrumBuffer || this._spectrumBuffer.length !== bins) {
        this._spectrumBuffer = new Uint8Array(bins);
      }
      this.analyser.getByteFrequencyData(this._spectrumBuffer);
      return this._spectrumBuffer;
    } catch (e) {
      return null;
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
    disconnectQuietly(this.air);
    for (var w = 0; w < this._widthNodes.length; w++) disconnectQuietly(this._widthNodes[w]);
    disconnectQuietly(this.warmDry);
    disconnectQuietly(this.warmWet);
    disconnectQuietly(this.shaper);
    disconnectQuietly(this.punch);
    disconnectQuietly(this.punchMakeup);
    disconnectQuietly(this.echoDelay);
    disconnectQuietly(this.echoTone);
    disconnectQuietly(this.echoFeedback);
    disconnectQuietly(this.echoWet);
    disconnectQuietly(this.dry);
    disconnectQuietly(this.convolver);
    disconnectQuietly(this.wet);
    disconnectQuietly(this.limiter);
    disconnectQuietly(this.master);
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

  /**
   * Normalised tanh curve: hard-pressed peaks, but unity-ish gain at the low
   * levels where most music lives, so the wet path does not jump in volume.
   */
  function buildSaturationCurve(drive) {
    var n = 2048;
    var curve = new Float32Array(n);
    var k = drive || 1;
    var norm = Math.tanh(k);
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / (n - 1) - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
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
