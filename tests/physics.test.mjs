/*
 * The physics contract: what a mode's frequency is, what the bridge passes, and
 * what a pluck puts into the string. Everything the UI prints is derived from
 * these, so an error here is an error on the page, not only in the sound.
 */
import { MODE_COUNT, bridgeWeight, bridgeBandHz, modeFrequency, pluckAmplitudes, midiToHz, modeDecay } from '../src/physics.js';

let failed = 0;
function ok(name, condition, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!condition) failed += 1;
}
function approx(a, b, tolerance) { return Math.abs(a - b) <= tolerance; }

// --- mode frequency -------------------------------------------------------
ok('B = 0 gives an exact harmonic series',
  approx(modeFrequency(110, 3, 0), 330, 1e-9));
ok('inharmonicity raises a high partial above its harmonic',
  modeFrequency(110, 16, 0.0004) > modeFrequency(110, 16, 0),
  `${modeFrequency(110, 16, 0.0004).toFixed(2)} > ${modeFrequency(110, 16, 0).toFixed(2)}`);
// The stiff-string law is f_k = k*f0*sqrt(1 + B*k^2), so at k=1 the shift is exactly
// f0*(sqrt(1+B)-1) = 0.022 Hz at B=4e-4. Asserted against the formula rather than a
// hand-picked tolerance: a tolerance chosen by eye is a number nobody can check.
ok('the fundamental follows sqrt(1 + B)',
  approx(modeFrequency(110, 1, 0.0004), 110 * Math.sqrt(1 + 0.0004), 1e-9),
  `${modeFrequency(110, 1, 0.0004).toFixed(6)} Hz`);
ok('a higher partial is stretched more than a lower one',
  (modeFrequency(110, 16, 0.0004) / 16) > (modeFrequency(110, 4, 0.0004) / 4));

// --- midi ------------------------------------------------------------------
ok('A4 is 440 Hz', approx(midiToHz(69), 440, 1e-9));
ok('an octave up doubles the frequency', approx(midiToHz(81), 880, 1e-9));

// --- bridge shape ---------------------------------------------------------
ok('the bridge peaks at its centre',
  bridgeWeight(8, 8, 3) > bridgeWeight(7, 8, 3) && bridgeWeight(8, 8, 3) > bridgeWeight(9, 8, 3));
ok('weights stay in [0, 1]', (() => {
  for (let k = 1; k <= MODE_COUNT; k += 1) {
    const w = bridgeWeight(k, 8, 3);
    if (!(w >= 0 && w <= 1)) return false;
  }
  return true;
})());
ok('a far partial is strongly attenuated', bridgeWeight(24, 3, 1) < 1e-8,
  bridgeWeight(24, 3, 1).toExponential(2));
ok('zero width passes nothing', bridgeWeight(3, 3, 0) === 0);

/*
 * The -3 dB edges. bridgeBandHz interpolates between integer modes, so the
 * reported edge is not exact -- what must be exact is that the *weight at the
 * reported edge* is 1/sqrt(2), because that is the definition being claimed.
 */
const half = 1 / Math.SQRT2;
for (const [centre, width] of [[3, 1], [8, 3], [12, 6]]) {
  const band = bridgeBandHz(centre, width, 220, 0);
  const wLow = bridgeWeight(band.lowHz / 220, centre, width);
  const wHigh = bridgeWeight(band.highHz / 220, centre, width);
  // Tolerance is tight because the crossing is now solved analytically. Linear
  // interpolation between integer modes sat at 0.7580 here -- a plausible-looking
  // number that put the quoted Hz about 9 Hz out on the page's headline claim.
  ok(`band edges sit at -3 dB (centre ${centre}, width ${width})`,
    approx(wLow, half, 1e-4) && approx(wHigh, half, 1e-4),
    `${wLow.toFixed(6)} / ${wHigh.toFixed(6)}`);
  ok(`band is ordered and inside the string's range (centre ${centre})`,
    band.lowHz < band.highHz && band.lowMode >= 1 && band.highMode <= MODE_COUNT,
    `${band.lowMode}-${band.highMode}`);
}
// When the window reaches past the string's last mode there is no -3 dB point to
// quote, and the page must not pretend otherwise: the reported edge is the end of
// the range and says so, rather than inventing a mode that does not exist.
{
  const clipped = bridgeBandHz(MODE_COUNT, 2, 220, 0);
  ok('a window past the top mode reports the range end, not a fake -3 dB edge',
    clipped.highMode === MODE_COUNT && clipped.highIsEdge === false,
    `highMode ${clipped.highMode}, highIsEdge ${clipped.highIsEdge}`);
  ok('its weight at the clipped edge is the string top, above half power',
    bridgeWeight(clipped.highHz / 220, MODE_COUNT, 2) > half);
  const wide = bridgeBandHz(1, 40, 220, 0);
  ok('a window covering everything marks neither edge as a crossing',
    wide.lowIsEdge === false && wide.highIsEdge === false);
}
// The readout must be in Hz, and Hz must respond to inharmonicity, because the
// index->Hz mapping is stretched -- the whole reason the Hz cannot be computed
// from the slider value.
{
  const plain = bridgeBandHz(8, 3, 220, 0);
  const stiff = bridgeBandHz(8, 3, 220, 0.0008);
  ok('stiffness moves the quoted band upward', stiff.highHz > plain.highHz,
    `${plain.highHz.toFixed(0)} -> ${stiff.highHz.toFixed(0)} Hz`);
}

// --- pluck spectrum -------------------------------------------------------
/*
 * A pluck in the middle kills every even partial. This is a real property of a
 * triangular initial displacement, and it is the clearest available proof that
 * pluck position does something physical rather than only changing the volume.
 */
{
  const mid = pluckAmplitudes(0.5, 12);
  let maxEven = 0;
  for (let k = 2; k <= 12; k += 2) maxEven = Math.max(maxEven, Math.abs(mid[k - 1]));
  ok('plucking at the centre cancels every even partial', maxEven < 1e-15,
    maxEven.toExponential(2));
  ok('plucking at the centre keeps the odd partials', Math.abs(mid[0]) > 0.3);
}
{
  const third = pluckAmplitudes(1 / 3, 9);
  let maxThirds = 0;
  for (const k of [3, 6, 9]) maxThirds = Math.max(maxThirds, Math.abs(third[k - 1]));
  ok('plucking at a third cancels every multiple of 3', maxThirds < 1e-15,
    maxThirds.toExponential(2));
}
{
  const off = pluckAmplitudes(0.27, 12);
  ok('an off-centre pluck has all partials present',
    [...off].every((v) => Math.abs(v) > 1e-6));
  ok('pluck amplitudes fall off with partial number',
    Math.abs(off[0]) > Math.abs(off[5]) && Math.abs(off[5]) > Math.abs(off[11]));
  ok('pluck amplitudes are finite', [...off].every(Number.isFinite));
}

// --- decay ----------------------------------------------------------------
ok('high modes decay faster than low ones',
  modeDecay(16, 2.4) < modeDecay(1, 2.4),
  `${modeDecay(16, 2.4).toFixed(3)}s < ${modeDecay(1, 2.4).toFixed(3)}s`);
ok('decay is positive and finite for every mode', (() => {
  for (let k = 1; k <= MODE_COUNT; k += 1) {
    const d = modeDecay(k, 2.4);
    if (!(d > 0 && Number.isFinite(d))) return false;
  }
  return true;
})());

console.log(failed === 0 ? 'physics checks passed' : `${failed} physics check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
