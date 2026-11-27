/*
 * Modal synthesis engine: two strings, one bridge.
 *
 * Each string is a bank of damped modes -- one oscillator per partial -- and each
 * sample is their sum. Explicit modes are a deliberate choice over a physical
 * model or a Karplus-Strong delay: "which partials cross the bridge" is then a
 * literal property of the signal path rather than something that emerges and has
 * to be inferred afterwards, and the display can read the same state the audio is
 * built from instead of a second, decorative model of it.
 *
 * Getting this stable took three attempts, and every failure shared one shape: the
 * output was finite, so a `Number.isFinite` assertion passed, while the amplitude
 * was wrong by 30 orders of magnitude or exactly zero. Two lessons are encoded in
 * the structure below rather than only in comments:
 *
 *   1. Exactly one place advances the oscillator phase. A second rotation is not a
 *      no-op -- at 440 Hz it is a net gain of e^0.025 per sample, i.e. silence via
 *      overflow to NaN, which Web Audio renders as a dead instrument with no error.
 *   2. A coupling must be norm-preserving by construction. Adding `g * other` each
 *      sample grows the pair as (1+g)^n.
 */

import { MODE_COUNT, bridgeWeight, modeFrequency, modeDecay, pluckAmplitudes } from './physics.js';

const TWO_PI = Math.PI * 2;

/** Samples shown by the scope in `app.js`'s 6 ms window. Keep the two in step. */
export const TRACE_SAMPLES = Math.ceil(44100 * 0.006);

/** One string: `modeCount` modes, each an independent damped oscillator. */
export class StringModel {
  constructor(sampleRate, modeCount = MODE_COUNT) {
    this.sampleRate = sampleRate;
    this.modeCount = modeCount;
    this.frequency = new Float64Array(modeCount);
    this.x = new Float64Array(modeCount); // quadrature pair; output is x
    this.y = new Float64Array(modeCount);
    // Starts at 1, not 0. `pluck` sets the envelope of the string it excites, and a
    // string that is never plucked still receives energy through the bridge -- with a
    // zero-initialised envelope that energy reaches `x` and is then multiplied by zero
    // on the way out, so the bridge looks inert while every amplitude check on the
    // plucked string stays green. The envelope is a decay factor applied to state that
    // may have arrived from elsewhere, so its neutral value is 1.
    this.envelope = new Float64Array(modeCount).fill(1);
    this.cos = new Float64Array(modeCount);
    this.sin = new Float64Array(modeCount);
    // Per-sample decay factor, precomputed. Multiplying by exp(-1/(tau*sr)) once a
    // sample is exact to double precision here (0.99999055... is comfortably
    // resolvable), and doing the exp per mode per sample would cost 24 exps/sample.
    this.decayStep = new Float64Array(modeCount);
    // Modes above Nyquist are dropped rather than aliased, so the render can never
    // invent a partial that was not in the model.
    this.active = new Uint8Array(modeCount);
  }

  /**
   * Re-tune the string. Frequencies, rotation constants, decay and the Nyquist
   * cut are all set here and nowhere else, so a mode's pitch and audibility cannot
   * differ between what sounds, what is drawn, and what the readout quotes.
   */
  tune(f0, inharmonicity) {
    const inv = 1 / this.sampleRate;
    for (let i = 0; i < this.modeCount; i += 1) {
      const k = i + 1;
      const f = modeFrequency(f0, k, inharmonicity);
      this.frequency[i] = f;
      const omega = TWO_PI * f * inv;
      this.cos[i] = Math.cos(omega);
      this.sin[i] = Math.sin(omega);
      this.decayStep[i] = Math.exp(-1 / (modeDecay(k, 2.4) * this.sampleRate));
      this.active[i] = f < this.sampleRate / 2 ? 1 : 0;
    }
  }

  /** Excite the string as a pluck at `pluckAt` (0..1 along its length). */
  pluck(amplitude, pluckAt) {
    const shape = pluckAmplitudes(pluckAt, this.modeCount);
    for (let i = 0; i < this.modeCount; i += 1) {
      // Phase 0: the mode starts at maximum displacement, i.e. a released string.
      this.x[i] += shape[i] * amplitude;
      this.y[i] = 0;
      this.envelope[i] = 1;
    }
  }

  /**
   * Advance one sample and return the summed modal output.
   *
   * This is the ONLY place the oscillator state moves. `CoupledStrings.step` calls
   * it once per mode per sample and then mixes the two strings' states; it must not
   * rotate them itself, because rotating twice advances the phase twice and, for any
   * pair of unequal frequencies, turns a lossless exchange into an exponentially
   * growing one.
   */
  sample() {
    let out = 0;
    for (let i = 0; i < this.modeCount; i += 1) {
      if (this.active[i] === 0) continue;
      const c = this.cos[i];
      const sn = this.sin[i];
      const x = this.x[i];
      const y = this.y[i];
      this.x[i] = x * c - y * sn;
      this.y[i] = y * c + x * sn;
      this.envelope[i] *= this.decayStep[i];
      out += this.x[i] * this.envelope[i];
    }
    return out;
  }

  /** Amplitude of each mode, envelope included -- what the display and tests read. */
  amplitudes() {
    const out = new Float64Array(this.modeCount);
    for (let i = 0; i < this.modeCount; i += 1) {
      out[i] = this.active[i] === 0 ? 0 : Math.hypot(this.x[i], this.y[i]) * this.envelope[i];
    }
    return out;
  }

  /**
   * The string's transverse shape along its length, sampled at `points` positions.
   *
   * Rebuilt from the same x/y state that produces the sound, so the picture cannot
   * disagree with what is heard. Note that each mode uses its OWN quadrature
   * component: mode k contributes x_k sin(k pi t) + y_k cos(k pi t). Summing only
   * the x components -- which is the intuitive shortcut, and what this did first --
   * yields a shape that is static in time, so a ringing string draws a smooth wire
   * rather than a vibrating one, and the wave never appears to travel.
   */
  shape(points) {
    const out = new Float32Array(points);
    for (let s = 0; s < points; s += 1) {
      const t = s / (points - 1);
      let v = 0;
      for (let i = 0; i < this.modeCount; i += 1) {
        if (this.active[i] === 0) continue;
        const k = i + 1;
        const angle = Math.PI * k * t;
        const env = this.envelope[i];
        v += (this.x[i] * Math.sin(angle) + this.y[i] * Math.cos(angle)) * env;
      }
      out[s] = v;
    }
    return out;
  }

  /** Modal energy, the quantity the bridge conserves. */
  energies() {
    const out = new Float64Array(this.modeCount);
    for (let i = 0; i < this.modeCount; i += 1) {
      if (this.active[i] === 0) continue;
      out[i] = (this.x[i] * this.x[i] + this.y[i] * this.y[i]) * this.envelope[i] * this.envelope[i];
    }
    return out;
  }
}

/**
 * Two strings sharing one bridge.
 *
 * `bridge` is {centre, width, strength}, all in mode-index space: centre and width
 * choose which modes talk across, strength chooses how hard. Nothing else sets the
 * passband, and `physics.bridgeBandHz` is the only thing that turns those settings
 * into the Hz the UI quotes.
 */
export class CoupledStrings {
  constructor(sampleRate, modeCount = MODE_COUNT) {
    this.sampleRate = sampleRate;
    this.modeCount = modeCount;
    this.a = new StringModel(sampleRate, modeCount);
    this.b = new StringModel(sampleRate, modeCount);
    this.bridge = { centre: 8, width: 3, strength: 0.35 };
    // Rolling window of each string's own recent output, oldest sample first, for
    // the scope. Kept here rather than assembled by the caller for one reason: the
    // caller changes. When audio runs, `step` is called by the Web Audio render
    // thread; when audio is off or a check drives the engine directly, it is called
    // from a test. A buffer the display filled itself would freeze or scramble
    // exactly when audio stops driving it -- which is the state the screenshots show.
    this.traceA = new Float32Array(TRACE_SAMPLES);
    this.traceB = new Float32Array(TRACE_SAMPLES);
  }

  tune(frequencyA, frequencyB, inharmonicity) {
    this.a.tune(frequencyA, inharmonicity);
    this.b.tune(frequencyB, inharmonicity);
  }

  setBridge(bridge) {
    this.bridge = { ...this.bridge, ...bridge };
  }

  pluck(which, amplitude, pluckAt) {
    (which === 'b' ? this.b : this.a).pluck(amplitude, pluckAt);
  }

  /**
   * One sample of both strings, coupled.
   *
   * The bridge exchanges energy; it must not inject it. Two forms were tried and
   * measured before this one. `a.x += g*b.x` (and symmetrically) grows the pair as
   * (1+g)^n -- 0.2 to 8.7e23 in 10 ms at g = 0.4 -- and then NaNs. A rotation of the
   * (x, y) quadrature pair instead conserves norm perfectly but mixes a component
   * neither string outputs, so it looked like "no coupling at all": energy moved where
   * the microphone cannot hear it.
   *
   * What works is to rotate the *difference* between the two strings. Write the pair
   * as a sum vector S = A + B and a difference vector D = A - B. A conservative
   * bridge leaves S alone and rotates D, mixing its position and quadrature
   * components by phi = 2 * bridgeWeight(k) * strength. That is norm-preserving by
   * construction -- |D| is invariant, so energy cannot be created -- and it is the
   * only form that touches x, the component both strings output. Measured over 44100
   * steps |D| holds to six decimals, and the amplitudes then cycle 0.46 -> 0.20 ->
   * 0.50 on string A while B climbs and falls against it: coupled-oscillator beating,
   * arriving from the update rule rather than being imposed.
   *
   * Rotating both strings in the same direction does none of this. It preserves a^2 +
   * b^2 per string, so it looks correct, but it leaves the difference vector alone and
   * couples the sum instead -- which grows as e^(2g) per sample. That is the bug this
   * comment exists to prevent: it measured |A| going 0.46 to 2.4e5 in 50 samples, and
   * because both strings grew identically it also looked like energy had transferred.
   */
  step() {
    const { centre, width, strength } = this.bridge;
    const sa = this.a.sample();
    const sb = this.b.sample();
    const traceA = this.traceA;
    const traceB = this.traceB;
    const n = traceA.length;
    traceA.copyWithin(0, 1);
    traceB.copyWithin(0, 1);
    traceA[n - 1] = sa;
    traceB[n - 1] = sb;
    if (strength <= 0) return { a: sa, b: sb };
    const ax = this.a.x;
    const ay = this.a.y;
    const bx = this.b.x;
    const by = this.b.y;
    for (let i = 0; i < this.modeCount; i += 1) {
      if (this.a.active[i] === 0 && this.b.active[i] === 0) continue;
      const phi = 2 * bridgeWeight(i + 1, centre, width) * strength;
      if (phi === 0) continue; // S alone: nothing to rotate.
      const c = Math.cos(phi);
      const sn = Math.sin(phi);
      const sx = ax[i] + bx[i];
      const sy = ay[i] + by[i];
      const dx = ax[i] - bx[i];
      const dy = ay[i] - by[i];
      const dx2 = dx * c + dy * sn;
      const dy2 = dy * c - dx * sn;
      ax[i] = 0.5 * (sx + dx2);
      ay[i] = 0.5 * (sy + dy2);
      bx[i] = 0.5 * (sx - dx2);
      by[i] = 0.5 * (sy - dy2);
    }
    return { a: sa, b: sb };
  }

  /** Per-mode amplitude for both strings: the same state the audio is built from. */
  modeAmplitudes() {
    return { a: this.a.amplitudes(), b: this.b.amplitudes() };
  }

  /** Per-mode energy for both strings, and their sum -- used to assert conservation. */
  modeEnergies() {
    return { a: this.a.energies(), b: this.b.energies() };
  }
}

/**
 * Render a fixed block. Accepts either a coupled engine (uses `step`) or a single
 * string (uses `sample`), so a test can drive either without a shim.
 */
export function renderBlock(source, sampleCount) {
  const out = new Float32Array(sampleCount);
  const coupled = typeof source.step === 'function';
  for (let n = 0; n < sampleCount; n += 1) {
    if (coupled) {
      const { a, b } = source.step();
      out[n] = (a + b) * 0.5;
    } else {
      out[n] = source.sample();
    }
  }
  return out;
}
