/*
 * The physics of two strings sharing one bridge.
 *
 * Each string is modelled the way a real one behaves: not as one oscillator but as
 * a stack of independent modes, one per partial. An ideal string's modes sit at
 * exact multiples of the fundamental. A real stiff string's do not -- bending
 * stiffness pushes the higher modes progressively sharper, and that stretch is
 * what makes a piano's octaves sound "too wide" and what keeps high partials from
 * locking into perfect unison. Here it is a parameter you can turn up and hear.
 *
 * The two strings are coupled only through the bridge, which is modelled as a
 * band-pass on mode index: mode k of one string drives mode k of the other only if
 * the bridge passes index k. That single rule is the instrument. Open the bridge
 * wide and the pair behaves like one string; narrow it and you get a fundamental
 * that crosses while the octaves stay behind, which is exactly the situation that
 * produces audible beats between two things that are almost, but not quite, the
 * same note.
 *
 * Nothing here is a look-up table of "sounds like X". Every number the UI prints is
 * measured out of the state defined in this file.
 */

/** Partial count per string. 24 is enough that inharmonicity is audible at the
 *  top partial while keeping the per-sample cost bounded. */
export const MODE_COUNT = 24;

/** Seconds per second of a quarter-tone detune at the fundamental, as a ratio. */
export const SEMITONE = Math.pow(2, 1 / 12);

/**
 * Frequency of mode `index` (1-based) of a string with fundamental `f0`.
 *
 * inharmonicity follows the stiff-string law f_k = k * f0 * sqrt(1 + B * k^2).
 * B is the standard piano inharmonicity coefficient: at B = 0 the partials are an
 * exact harmonic series, and each octave of partials is pushed sharper by roughly
 * the square-root term. Kept explicit and shared so the UI, the tests and the
 * synth cannot disagree about what a mode's frequency is.
 */
export function modeFrequency(f0, index, inharmonicity) {
  const k = index;
  return k * f0 * Math.sqrt(1 + inharmonicity * k * k);
}

/**
 * Does mode index k pass the bridge?
 *
 * A first-order band-pass has a -3 dB point at its cutoff, and a second-order one
 * falls 12 dB per octave beyond it. Rather than reproduce that filter, the bridge is
 * a smooth window over mode index, which is what a physical bridge does: it does not
 * chop modes, it attenuates them progressively. The window is Gaussian in log-index,
 * so a decade of indices is what `width` means to a player rather than a raw count.
 */
export function bridgeWeight(index, centre, width) {
  if (width <= 0) return 0;
  const t = (index - centre) / width;
  return Math.exp(-0.5 * t * t);
}

/** Energy transfer between two modes one step apart through the bridge. */
export function coupleCoefficient(weight, strength) {
  return weight * strength;
}

/**
 * A pluck's initial modal amplitudes.
 *
 * A real pluck displaces the string into a triangle, whose Fourier coefficients
 * fall off as 1/k^2 and whose sign flips with position. Doing the sum here is the
 * difference between "a sine stack that is bright" and a pluck with the same
 * bright-then-dull evolution a finger produces. `pluckAt` is the fraction along the
 * string where the pluck happens; at 1/2 every even partial is missing, which is a
 * real and audible fact about plucking a string in the middle.
 */
export function pluckAmplitudes(pluckAt, modeCount) {
  const amplitudes = new Float64Array(modeCount);
  const h = clamp01(pluckAt);
  for (let k = 1; k <= modeCount; k += 1) {
    const s = Math.sin(Math.PI * k * h);
    // 1/k^2 from the triangular initial shape; the sign is already inside s.
    amplitudes[k - 1] = s / (k * k);
  }
  return amplitudes;
}

/** Per-mode decay rate, in seconds. Real strings lose high modes faster. */
export function modeDecay(index, baseSeconds) {
  // A high mode has more curvature, so internal losses drain it sooner. The 1/k^0.4
  // factor is a compromise between the theoretical k^2 of beam losses and the
  // near-flat decay measured on lightly-damped wire; it is a parameter, not a law.
  return baseSeconds / Math.pow(index, 0.4);
}

/** Frequency in Hz of a MIDI note number, the same formula the UI prints. */
export function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The bridge's passband in Hz, measured from its own weights.
 *
 * This is the number the UI shows as "the bridge passes ... Hz". It must not be
 * derived from the nominal centre slider, because the slider is in *mode index* and
 * the mapping index->Hz is stretched by inharmonicity: two strings with the same
 * bridge setting pass different Hz. So the cutoffs are found by walking the modes
 * and stopping where the weight crosses 1/sqrt(2), interpolating between modes so
 * the reported edge is not quantised to an integer index.
 */
export function bridgeBandHz(centre, width, f0, inharmonicity, modeCount = MODE_COUNT) {
  if (width <= 0) return { lowHz: 0, highHz: 0, lowMode: 0, highMode: 0 };
  /*
   * Solve the crossing rather than interpolating between the two integer weights.
   * Linear interpolation of a Gaussian looked close but was not: for centre 3 /
   * width 1 it put the low edge at mode 2.256 where the true -3 dB point is 2.167,
   * so the Hz printed on the page was off by ~9 Hz on a claim whose whole point is
   * being the real passband. Inverting the window analytically is exact -- and for
   * this Gaussian that inverse is just centre +/- width * sqrt(ln 2).
   */
  const halfWidth = width * Math.sqrt(Math.LN2);
  const peak = Math.max(1, Math.min(modeCount, Math.round(centre)));
  const lowEdge = centre - halfWidth;
  const highEdge = centre + halfWidth;
  // Clamped to the string's own modes, and reported as such: when the window covers
  // or exceeds the range there is no -3 dB point inside it, and saying "partial 1-N"
  // is honest where quoting the analytic edge would invent modes that do not exist.
  const lowMode = Math.max(1, lowEdge);
  const highMode = Math.min(modeCount, highEdge);
  const coversLow = lowEdge <= 1;
  const coversHigh = highEdge >= modeCount;
  return {
    lowHz: modeFrequency(f0, lowMode, inharmonicity),
    highHz: modeFrequency(f0, highMode, inharmonicity),
    lowMode: Math.round(lowMode),
    highMode: Math.round(highMode),
    // Whether each edge is a real -3 dB crossing or the end of the string's range.
    lowIsEdge: !coversLow,
    highIsEdge: !coversHigh,
    peakMode: peak,
  };
}
