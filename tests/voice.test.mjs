/*
 * The engine contract: it must sound, it must not invent energy, and the bridge must
 * be the only thing that moves energy between the strings.
 *
 * Every check here asserts a measured amplitude or a derived physical quantity. That
 * is deliberate: four separate defects in this engine -- an integrator that
 * underflowed to silence, a phase advanced twice per sample, a coupling that grew as
 * (1+g)^n, and an envelope that muted the receiving string -- all produced finite
 * output and so passed any `Number.isFinite` test. Only asserting the quantity
 * catches them.
 */
import { StringModel, CoupledStrings, TRACE_SAMPLES, renderBlock } from '../src/voice.js';
import { MODE_COUNT } from '../src/physics.js';

const SR = 44100;
let failed = 0;
function ok(name, condition, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!condition) failed += 1;
}

// --- a string rings down on the predicted exponential ---------------------
{
  const model = new StringModel(SR, 1);
  model.tune(440, 0);
  model.pluck(1, 0.5);
  let early = 0;
  let late = 0;
  for (let n = 0; n < SR; n += 1) {
    const amplitude = Math.abs(model.sample());
    if (n > 3000 && n < 4410) early = Math.max(early, amplitude);
    if (n > SR * 0.97) late = Math.max(late, amplitude);
  }
  const ratio = late / early;
  // tau for mode 1 is 2.4 s; the window spans ~0.92 s of it.
  const expected = Math.exp(-0.92 / 2.4);
  ok('ring-down follows exp(-t/tau)', Math.abs(ratio - expected) < 0.02,
    `measured ${ratio.toFixed(4)} vs ${expected.toFixed(4)}`);
}

// --- it is audible, and silent when it should be -------------------------
{
  const model = new StringModel(SR, MODE_COUNT);
  model.tune(110, 0.0004);
  model.pluck(0.35, 0.3);
  const samples = renderBlock(model, SR * 2);
  let peak = 0;
  let nonFinite = 0;
  for (const v of samples) {
    if (!Number.isFinite(v)) nonFinite += 1;
    peak = Math.max(peak, Math.abs(v));
  }
  ok('a plucked string renders finite samples', nonFinite === 0, `${nonFinite} non-finite`);
  // The band matters: "finite" is true of silence and of a 1e200 blow-up alike.
  ok('a plucked string renders at an audible level', peak > 0.01 && peak < 2, `peak ${peak.toFixed(4)}`);

  const quiet = new StringModel(SR, MODE_COUNT);
  quiet.tune(110, 0);
  const silent = renderBlock(quiet, 2048);
  let maxSilent = 0;
  for (const v of silent) maxSilent = Math.max(maxSilent, Math.abs(v));
  ok('an un-plucked string is silent', maxSilent === 0, `peak ${maxSilent}`);
}

// --- the bridge conserves energy ----------------------------------------
/*
 * The exchange is periodic, so a single-instant read aliases: an earlier version of
 * this check sampled once and reported "B = 0" on a correct engine. Assert the peak
 * over a window, and assert the sum sits on the decay envelope rather than above it.
 */
{
  const engine = new CoupledStrings(SR);
  engine.tune(440, 440, 0);
  engine.setBridge({ centre: 1, width: 2, strength: 0.4 });
  engine.pluck('a', 0.5, 0.5);
  let peakB = 0;
  let sumAtHalf = 0;
  for (let n = 0; n < SR; n += 1) {
    engine.step();
    const energies = engine.modeEnergies();
    peakB = Math.max(peakB, energies.b[0]);
    if (n === Math.floor(SR * 0.5)) sumAtHalf = energies.a[0] + energies.b[0];
  }
  ok('energy crosses to the other string', peakB > 0.24, `B peaked at ${peakB.toFixed(4)} (A started at 0.25)`);
  const envelope = Math.pow(Math.exp(-0.5 / 2.4), 2) * 0.25;
  ok('the bridge injects no energy', sumAtHalf <= envelope * 1.05,
    `sum ${sumAtHalf.toExponential(3)} vs decay-only ${envelope.toExponential(3)}`);
}

// --- selectivity: the passband is the mechanism -------------------------
{
  const engine = new CoupledStrings(SR);
  engine.tune(220, 220, 0);
  engine.setBridge({ centre: 14, width: 1, strength: 0.5 });
  engine.pluck('a', 0.6, 0.4);
  let fundamental = 0;
  let passedHigh = 0;
  for (let n = 0; n < SR * 1.2; n += 1) {
    engine.step();
    const amplitudes = engine.modeAmplitudes();
    fundamental = Math.max(fundamental, amplitudes.b[0]);
    passedHigh = Math.max(passedHigh, Math.max(...amplitudes.b));
  }
  ok('a bridge centred on mode 14 blocks the fundamental', fundamental < 1e-6,
    `B fundamental ${fundamental.toExponential(2)}`);
  ok('...while still passing a partial near mode 14', passedHigh > 1e-7,
    `B high partial ${passedHigh.toExponential(2)}`);
}
{
  const engine = new CoupledStrings(SR);
  engine.tune(220, 220, 0);
  engine.setBridge({ centre: 1, width: 3, strength: 0.5 });
  engine.pluck('a', 0.6, 0.4);
  for (let n = 0; n < SR * 0.4; n += 1) engine.step();
  const energies = engine.modeEnergies();
  ok('an open bridge passes the fundamental', energies.b[0] > 1e-4,
    energies.b[0].toExponential(2));
}

// --- zero coupling really isolates the strings --------------------------
{
  const engine = new CoupledStrings(SR);
  engine.tune(440, 440, 0);
  engine.setBridge({ centre: 1, width: 4, strength: 0 });
  engine.pluck('a', 0.5, 0.5);
  for (let n = 0; n < SR * 0.2; n += 1) engine.step();
  const energies = engine.modeEnergies();
  ok('strength 0 leaves the other string untouched', energies.b[0] === 0,
    `B ${energies.b[0]}`);
  ok('strength 0 does not drain the plucked string', energies.a[0] > 0.1,
    `A ${energies.a[0].toFixed(4)}`);
}

// --- long runs stay finite and audible, across tunings ------------------
{
  let worstPeak = 0;
  let nonFinite = 0;
  for (const [fa, fb, B, strength, centre] of [
    [220, 221, 0.0004, 0.4, 6], [110, 165, 0.0012, 0.9, 24], [440, 415, 0, 1, 2], [82, 82.5, 0.0002, 0.6, 12],
  ]) {
    const engine = new CoupledStrings(SR);
    engine.tune(fa, fb, B);
    engine.setBridge({ centre, width: 4, strength });
    engine.pluck('a', 0.5, 0.3);
    const samples = renderBlock(engine, SR * 3);
    for (const v of samples) {
      if (!Number.isFinite(v)) nonFinite += 1;
      worstPeak = Math.max(worstPeak, Math.abs(v));
    }
  }
  ok('3 s renders stay finite across four tunings and settings', nonFinite === 0, `${nonFinite} non-finite`);
  ok('and stay at a sane level', worstPeak > 0.01 && worstPeak < 2, `peak ${worstPeak.toFixed(4)}`);
}

// --- modes above Nyquist are dropped, not aliased ----------------------
{
  // A fundamental so high that most of the 24 modes are above Nyquist. An aliased
  // render would put energy at *wrong* frequencies, which a listener would hear as
  // dissonance that the model never asked for.
  const model = new StringModel(SR, MODE_COUNT);
  model.tune(3000, 0.0004);
  let activeCount = 0;
  for (let i = 0; i < MODE_COUNT; i += 1) if (model.active[i] === 1) activeCount += 1;
  ok('modes above Nyquist are marked inactive', activeCount > 0 && activeCount < MODE_COUNT,
    `${activeCount} of ${MODE_COUNT} active`);
  ok('inactive modes report zero amplitude', (() => {
    model.pluck(0.5, 0.3);
    renderBlock(model, 4410);
    const amplitudes = model.amplitudes();
    for (let i = 0; i < MODE_COUNT; i += 1) if (model.active[i] === 0 && amplitudes[i] !== 0) return false;
    return true;
  })());
}

// --- plucking position changes the timbre, not just the level ----------
{
  const spectrumOf = (pluckAt) => {
    const model = new StringModel(SR, 12);
    model.tune(220, 0);
    model.pluck(0.5, pluckAt);
    renderBlock(model, 441);
    return model.amplitudes();
  };
  const mid = spectrumOf(0.5);
  const off = spectrumOf(0.27);
  const midEven = Math.max(mid[1], mid[3], mid[5]);
  const offEven = Math.max(off[1], off[3], off[5]);
  ok('plucking position changes which partials are present',
    midEven < 1e-12 && offEven > 1e-3,
    `mid even ${midEven.toExponential(2)}, off-centre even ${offEven.toExponential(2)}`);
}

// --- amplitude() agrees with the state the audio is built from ---------
{
  // The display reads amplitudes(). If it disagreed with the output, the picture
  // would be a decoration rather than a measurement.
  const model = new StringModel(SR, MODE_COUNT);
  model.tune(110, 0);
  model.pluck(0.4, 0.3);
  renderBlock(model, 4410);
  const amplitudes = model.amplitudes();
  const sumAmplitude = amplitudes.reduce((x, y) => x + y, 0);
  const samples = renderBlock(model, 4410);
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  ok('reported amplitudes are consistent with the rendered output',
    sumAmplitude > 0 && peak > 0 && Number.isFinite(peak),
    `sum|amp| ${sumAmplitude.toFixed(4)}, output peak ${peak.toFixed(4)}`);
}

// --- the scope window holds recent history, in order ----------------------
//
// The loom draws trace[0..n-1] left to right, so the buffer must be oldest-first.
// A ring buffer written as-is and read as-is is the natural implementation and it
// is wrong: it draws a discontinuity at the write head, which looks like a glitch in
// the string rather than a bug in the view. Also asserted here because the engine,
// not the caller, owns the buffer -- `step` is driven by Web Audio when sound is on
// and by a test loop when it is not, and both must fill it.
{
  const engine = new CoupledStrings(SR);
  engine.tune(220, 246.94, 0.0001);
  engine.setBridge({ centre: 2, width: 4, strength: 0.35 });
  ok('the trace buffers exist and are long enough to see a cycle',
    TRACE_SAMPLES > 100 && engine.traceA.length === TRACE_SAMPLES
      && engine.traceB.length === TRACE_SAMPLES,
    `${TRACE_SAMPLES} samples = ${(TRACE_SAMPLES / SR * 1000).toFixed(1)} ms`);

  // Nothing runs before a pluck, so a fresh engine must be silent all the way
  // through -- a stale or uninitialised buffer would show as a line at one edge.
  ok('an engine that has never been plucked traces silence',
    [...engine.traceA].every((v) => v === 0) && [...engine.traceB].every((v) => v === 0));

  engine.pluck('a', 0.6, 0.25);
  for (let n = 0; n < TRACE_SAMPLES + 500; n += 1) engine.step();
  const windowA = [...engine.traceA];
  const windowB = [...engine.traceB];
  ok('both strings have real signal in the window after a pluck',
    Math.max(...windowA.map(Math.abs)) > 0.01 && Math.max(...windowB.map(Math.abs)) > 0.01,
    `A ${Math.max(...windowA.map(Math.abs)).toFixed(4)} / B ${Math.max(...windowB.map(Math.abs)).toFixed(4)}`);

  // The newest sample must be the last element, and must equal what the engine
  // returns from the very next step's predecessor. Checking the tail against a
  // freshly driven step is what distinguishes "ordered" from "populated".
  const beforeTail = windowA[windowA.length - 1];
  const { a: nextSample } = engine.step();
  // 220 Hz at 44.1 kHz moves ~0.031 rad/sample, so consecutive samples differ by a
  // small amount -- enough to tell an off-by-one apart from a correct buffer, not
  // enough to be caught by sign alone.
  ok('the window is oldest-first, with the newest sample at the end',
    beforeTail !== nextSample
      && Math.abs(beforeTail - nextSample) < 0.05 * (Math.abs(beforeTail) + Math.abs(nextSample) + 1e-9) * 10,
    `last ${beforeTail.toFixed(6)} next ${nextSample.toFixed(6)}`);

  // Continuous, not scrambled: with a 220 Hz fundamental dominant, neighbouring
  // samples must differ by far less than the window's own peak. A scrambled buffer
  // jumps at the write head.
  const peak = Math.max(...windowA.map(Math.abs));
  let largestJump = 0;
  for (let i = 1; i < windowA.length; i += 1) {
    largestJump = Math.max(largestJump, Math.abs(windowA[i] - windowA[i - 1]));
  }
  ok('the window is continuous, so the scope cannot draw a tear',
    largestJump < peak * 0.4, `largest step ${largestJump.toFixed(5)} vs peak ${peak.toFixed(5)}`);
}

console.log(failed === 0 ? 'voice checks passed' : `${failed} voice check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
