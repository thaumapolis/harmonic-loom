/*
 * The playable layer: Web Audio, two canvases, pointer input.
 *
 * One rule governs this file: the picture is taken from the engine's own mode
 * states, never from a second model of them. A display that recomputes its own
 * "energy" is a decoration that can drift from the sound, and a drifting
 * explanation is worse than no explanation.
 *
 * Audio and animation share the sample-accurate clock by pulling from the engine
 * inside an AudioWorklet-free script node: the engine is advanced exactly one
 * sample per audio sample, so what is drawn and what is heard come from one run.
 * (A ScriptProcessorNode is used rather than an AudioWorklet so the whole app
 * stays one file with no worker URL, which is what the offline/single-file
 * promise requires.)
 */

import { CoupledStrings, renderBlock } from './voice.js';
import { MODE_COUNT, bridgeBandHz, midiToHz, bridgeWeight } from './physics.js';

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Note label for a MIDI number, e.g. 69 -> "A4". Used for both the selects and the readout. */
export function noteLabel(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  return `${name}${Math.floor(midi / 12) - 1}`;
}

const state = {
  running: false,
  midiA: 57,   // A3
  midiB: 59,   // B3
  centre: 3,
  width: 2.6,
  strength: 0.35,
  inharmonicity: 0.00012,
  pluckAt: 0.28,
};

const engine = new CoupledStrings(44100, MODE_COUNT);

function applyTuning() {
  engine.tune(midiToHz(state.midiA), midiToHz(state.midiB), state.inharmonicity);
  engine.setBridge({ centre: state.centre, width: state.width, strength: state.strength });
}

const els = {};
function bind() {
  const ids = ['play', 'pluckA', 'pluckB', 'noteA', 'noteB', 'centre', 'width', 'strength', 'inharm',
    'centreVal', 'widthVal', 'strengthVal', 'inharmVal', 'help', 'overlay', 'loom', 'spectrum',
    'rA', 'rB', 'rBridge', 'rEA', 'rEB', 'rNote', 'bandCaption'];
  for (const id of ids) els[id] = document.getElementById(id);

  // Notes: two octaves of C2..C6 is more choice than a phone screen can show, so
  // the selects span A2..A5 -- enough that a fifth, an octave and a tritone are all
  // reachable, which are the intervals where the bridge does something distinct.
  for (const sel of [els.noteA, els.noteB]) {
    for (let midi = 45; midi <= 81; midi += 1) {
      const o = document.createElement('option');
      o.value = String(midi);
      o.textContent = noteLabel(midi);
      sel.appendChild(o);
    }
  }
  els.noteA.value = String(state.midiA);
  els.noteB.value = String(state.midiB);

  els.play.addEventListener('click', togglePlay);
  els.pluckA.addEventListener('click', () => pluck('a'));
  els.pluckB.addEventListener('click', () => pluck('b'));
  els.help.addEventListener('click', () => toggleOverlay(els.overlay.classList.contains('hidden')));
  const start = els.overlay.querySelector('button[data-action="start"]');
  if (start) start.addEventListener('click', () => { toggleOverlay(false); if (!state.running) togglePlay(); });

  for (const [id, key, format] of [['centre', 'centre', (v) => String(v)], ['width', 'width', (v) => v.toFixed(1)],
    ['strength', 'strength', (v) => v.toFixed(2)], ['inharm', 'inharmonicity', (v) => v.toFixed(5)]]) {
    els[id].addEventListener('input', () => {
      state[key] = Number(els[id].value);
      els[id === 'inharm' ? 'inharmVal' : `${key}Val`] && (els[id === 'inharm' ? 'inharmVal' : `${key}Val`].textContent = format(state[key]));
      applyTuning();
    });
  }
  els.noteA.addEventListener('change', () => { state.midiA = Number(els.noteA.value); applyTuning(); refreshReadout(); });
  els.noteB.addEventListener('change', () => { state.midiB = Number(els.noteB.value); applyTuning(); refreshReadout(); });
}

function toggleOverlay(show) {
  els.overlay.classList.toggle('hidden', !show);
  els.help.setAttribute('aria-pressed', String(show));
}

let audio = null;
function togglePlay() {
  if (!state.running) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { els.rNote.textContent = 'this browser has no Web Audio; the display still animates'; }
    if (Ctx && !audio) {
      audio = new Ctx();
      // 2048 samples per callback: at 44.1k that is ~46 ms, long enough that the
      // engine's per-sample loop is amortised and short enough to stay responsive.
      // Two output channels: channel 0 is string A, channel 1 is string B. Panning
      // them apart makes the energy transfer audible as movement across the stereo
      // field, which is the one part of the mechanism a screen cannot show.
      const node = audio.createScriptProcessor(2048, 0, 2);
      node.onaudioprocess = (event) => {
        const outA = event.outputBuffer.getChannelData(0);
        const outB = event.outputBuffer.getChannelData(1);
        for (let n = 0; n < outA.length; n += 1) {
          const { a, b } = engine.step();
          outA[n] = a * 0.45;
          outB[n] = b * 0.45;
        }
      };
      // Split the two channels, pan each, then join. Note that each node reaches
      // destination exactly once: connecting the dry node as well -- which is what
      // this did first, via `gain.connect(destination)` alongside the panners --
      // plays every string twice, unpanned, so the stereo cue that carries the
      // mechanism is washed out while the level looks normal.
      const splitter = audio.createChannelSplitter(2);
      const merger = audio.createChannelMerger(2);
      const panA = audio.createStereoPanner();
      const panB = audio.createStereoPanner();
      panA.pan.value = -0.65;
      panB.pan.value = 0.65;
      const gain = audio.createGain();
      gain.gain.value = 0.9;
      node.connect(splitter);
      splitter.connect(panA, 0);
      splitter.connect(panB, 1);
      panA.connect(merger, 0, 0);
      panB.connect(merger, 0, 1);
      merger.connect(gain);
      gain.connect(audio.destination);
    }
    if (audio) audio.resume();
    state.running = true;
    els.play.textContent = 'Stop';
    els.play.setAttribute('aria-pressed', 'true');
  } else {
    if (audio) audio.suspend();
    state.running = false;
    els.play.textContent = 'Play';
    els.play.setAttribute('aria-pressed', 'false');
  }
}

function pluck(which, amplitude = 0.55) {
  engine.pluck(which, amplitude, state.pluckAt);
}

/**
 * Silence both strings and restore the settings.
 *
 * Exposed for the browser checks: the coupling is periodic and persistent, so a
 * check that measures "does the bridge pass the fundamental" inherits whatever is
 * already ringing in the other string and measures that instead. A mechanism test
 * that cannot reach a known initial state is not testing the mechanism -- the first
 * version of `a high bridge blocks the fundamental` reported 2.45e-1, which was
 * leftover energy from the check before it, not a leak through the bridge.
 */
export function resetForTest(overrides = {}) {
  for (const string of [engine.a, engine.b]) {
    string.x.fill(0);
    string.y.fill(0);
    string.envelope.fill(1);
  }
  Object.assign(state, overrides);
  applyTuning();
  refreshReadout();
}

/* --- input on the canvas: drag near a string to pluck it ------------------- */
function bindCanvas() {
  let down = null;
  const pick = (event) => {
    const rect = els.loom.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x, y };
  };
  els.loom.addEventListener('pointerdown', (event) => {
    els.loom.setPointerCapture(event.pointerId);
    down = pick(event);
  });
  els.loom.addEventListener('pointerup', (event) => {
    if (!down) return;
    const up = pick(event);
    const moved = Math.hypot(up.x - down.x, up.y - down.y);
    // A tap plucks at the tap position; a drag sets the pluck position along the
    // string, which is a real control: at the middle the even partials vanish.
    const which = down.y < 0.5 ? 'a' : 'b';
    state.pluckAt = Math.min(0.92, Math.max(0.05, moved > 0.02 ? up.x : down.x));
    pluck(which, moved > 0.02 ? Math.min(0.9, 0.35 + moved) : 0.55);
    if (!state.running) togglePlay();
    down = null;
  });
  els.loom.addEventListener('pointercancel', () => { down = null; });
}

/* --- rendering ------------------------------------------------------------- */
const DPR = () => Math.min(3, window.devicePixelRatio || 1);

function sizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = DPR();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { ctx: canvas.getContext('2d'), w, h, dpr };
}

/**
 * The loom: the last few milliseconds of each string's own output, as two traces.
 *
 * Two attempts at this view were wrong in opposite ways, and both are worth the
 * description because each produced a plausible-looking picture of the wrong thing.
 *
 * The first summed `amps[k] * sin(k pi x)` -- modal amplitudes against position
 * along the string. Two faults: it dropped each mode's quadrature phase, so the
 * curve was frozen in time (a ringing string drawn as a static wire), and a single
 * 220 Hz mode has a wavelength ~2 m, far longer than the screen, so the whole string
 * appeared as one gentle slope. Physically defensible, visually meaningless.
 *
 * A short time window is the view that actually shows vibration: 24 modes summed
 * cross zero ~47 times in 6 ms, so the trace has structure the eye can follow, and
 * it is literally the signal the speaker receives -- the same claim the spectrum
 * makes in a different domain.
 *
 * Both traces share one vertical scale. That matters: normalising each lane to its
 * own peak would draw the quiet string as large as the loud one and hide the very
 * transfer the page exists to show.
 */
const TRACE_MS = 6;

function drawLoom() {
  const { ctx, w, h } = sizeCanvas(els.loom);
  ctx.clearRect(0, 0, w, h);
  const dpr = DPR();
  const amps = engine.modeAmplitudes();

  // The bridge's passband, as a short ruler along the top edge. The words live in
  // the DOM band above the canvas (#bandCaption): at landscape height the canvas
  // has no spare row, and a caption drawn inside it landed on the trace labels.
  const band = bridgeBandHz(state.centre, state.width, midiToHz(state.midiA), state.inharmonicity);
  els.bandCaption.textContent = `bridge passes partial ${band.lowMode}\u2013${band.highMode}`;
  const nyq = engine.sampleRate / 2;
  const xLow = Math.max(0, (band.lowHz / nyq) * w);
  const xHigh = Math.min(w, (band.highHz / nyq) * w);
  ctx.fillStyle = 'rgba(185,143,224,0.20)';
  ctx.fillRect(xLow, 0, Math.max(2, xHigh - xLow), 8 * dpr);

  const midY = h * 0.5;
  // One scale for both strings, from the loudest sample in either window. Scaling
  // each to its own peak would draw the quiet string as large as the loud one and
  // hide the transfer, which is the entire point of the page.
  let peak = 1e-6;
  for (const v of engine.traceA) peak = Math.max(peak, Math.abs(v));
  for (const v of engine.traceB) peak = Math.max(peak, Math.abs(v));
  const scale = h * 0.34 / peak;

  const stroke = (trace, color, width, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < trace.length; i += 1) {
      const x = (i / (trace.length - 1)) * w;
      const y = midY - trace[i] * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY); ctx.stroke();

  // Both windows on one axis. Drawn on two separate axes first, and that turned the
  // page into a memory test: to see energy leave A and arrive in B the viewer had to
  // hold A's envelope in mind while looking at B's. Overlaid, the crossover is a
  // single frame -- A thinning as B thickens. B sits behind and fainter, so the
  // brightest line is whichever string the last pluck drove.
  stroke(engine.traceB, cssVar('--b'), Math.max(1.7, 1.5 * dpr), 0.55);
  stroke(engine.traceA, cssVar('--a'), Math.max(1.9, 1.6 * dpr), 1);

  // Legend, naming each trace by pitch so A and B carry meaning on their own.
  const legend = [
    { color: cssVar('--a'), text: `A ${noteLabel(state.midiA)}`, total: amps.a.reduce((x, y) => x + y, 0) },
    { color: cssVar('--b'), text: `B ${noteLabel(state.midiB)}`, total: amps.b.reduce((x, y) => x + y, 0) },
  ];
  ctx.font = `${12 * dpr}px ui-sans-serif, system-ui, sans-serif`;
  let lx = 10 * dpr;
  for (const item of legend) {
    ctx.fillStyle = item.color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(lx, h - 19 * dpr, 12 * dpr, 3 * dpr);
    const label = item.total < 1e-4 ? `${item.text} \u00b7 silent` : item.text;
    ctx.fillText(label, lx + 16 * dpr, h - 14 * dpr);
    ctx.globalAlpha = 1;
    lx += 16 * dpr + ctx.measureText(label).width + 18 * dpr;
  }
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  ctx.font = `${10 * dpr}px ui-monospace, monospace`;
  const note = `${TRACE_MS} ms window`;
  ctx.fillText(note, w - ctx.measureText(note).width - 10 * dpr, h - 14 * dpr);
}

/*
 * The spectrum: one bar per partial, stacked green (A) over blue (B).
 *
 * Height is 20*log10(amplitude), truncated at -60 dB and labelled as such. The
 * first version used `Math.pow(value / peak, 0.55)` to "keep quiet partials
 * visible", and it did -- fatally so. At the tuning in the golden, partial 1 on A
 * holds 0.114 and partial 18 holds 0.00025, a ratio of 450:1. The power-law drew
 * those as 9.6% and 3.6% of the canvas height, so the spectrum read as a broad
 * spread of high partials with the fundamental merely the tallest of them. The
 * truth is the opposite: the fundamental is ~54 dB above everything else, and the
 * high partials are a floor. A plot whose caption says "the bars show where the
 * energy actually is" cannot invert that.
 *
 * A log scale is the only one that serves both ends here. Linear puts the 18
 * quieter partials at zero height -- honest, but it hides the mechanism's
 * fingerprint, which is precisely *which* partials survive the bridge. Pure power
 * law lies in the other direction. dB is also what ears do to a spectrum.
 */
const SPECTRUM_FLOOR_DB = -60;

function drawSpectrum() {
  const { ctx, w, h } = sizeCanvas(els.spectrum);
  ctx.clearRect(0, 0, w, h);
  const amps = engine.modeAmplitudes();
  const peak = Math.max(1e-6, ...amps.a, ...amps.b);
  const base = cssVar('--bridge');
  const plotH = h - 22 * DPR();
  const dpr = DPR();
  // Gridlines every 12 dB, so the bar heights can be read rather than merely compared.
  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  ctx.fillStyle = 'rgba(255,255,255,0.26)';
  ctx.lineWidth = 1;
  ctx.font = `${9 * dpr}px ui-monospace, monospace`;
  // Labels get their own gutter on the left and the bars start after it. Printed at
  // x=2 over the plot first, which clipped each label to two characters and put it
  // on top of partial 1 -- the bar a reader most needs to compare against the axis.
  const gutter = ctx.measureText(String(SPECTRUM_FLOOR_DB)).width + 8 * dpr;
  const slot = (w - gutter) / MODE_COUNT;
  const bw = Math.max(2, slot * 0.62);
  for (let db = -12; db >= SPECTRUM_FLOOR_DB; db -= 12) {
    const y = h - 12 * dpr - ((db - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB) * plotH;
    ctx.beginPath(); ctx.moveTo(gutter, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText(`${db}`, 2 * dpr, y + 3 * dpr);
  }
  for (let k = 0; k < MODE_COUNT; k += 1) {
    const cx = gutter + slot * (k + 0.5);
    // Passband marker: how much of this partial the bridge lets through.
    const pass = bridgeWeight(k + 1, state.centre, state.width);
    if (pass > 0.02) {
      ctx.fillStyle = base;
      ctx.globalAlpha = 0.13 * pass;
      ctx.fillRect(cx - bw / 2, 0, bw, h - 12 * dpr);
      ctx.globalAlpha = 1;
    }
    // Overlaid from a common baseline, narrower bar for B. Stacking them is the
    // tempting reading -- "total height = total loudness" -- but it is wrong twice
    // over: dB values do not add, and the two strings are not in phase, so neither
    // the summed amplitude nor the summed height means anything. Drawn from the
    // floor, each bar is a loudness and the two can be compared directly.
    for (const [value, color, shrink] of [
      [amps.a[k], cssVar('--a'), 1],
      [amps.b[k], cssVar('--b'), 0.52],
    ]) {
      const db = 20 * Math.log10(Math.max(1e-12, value) / peak);
      if (db <= SPECTRUM_FLOOR_DB) continue;
      const barH = ((db - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB) * plotH;
      const wBar = bw * shrink;
      ctx.fillStyle = color;
      ctx.fillRect(cx - wBar / 2, h - 12 * dpr - barH, wBar, barH);
    }
    if (slot > 26 * dpr) {
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.font = `${9 * dpr}px ui-monospace, monospace`;
      ctx.fillText(String(k + 1), cx - 3.5 * dpr, h - 3 * dpr);
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  ctx.font = `${10 * dpr}px ui-monospace, monospace`;
  ctx.fillText('dB rel. loudest partial', w - 178 * dpr, 12 * dpr);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#fff';
}

function refreshReadout() {
  els.rA.textContent = `${noteLabel(state.midiA)} · ${midiToHz(state.midiA).toFixed(1)} Hz`;
  els.rB.textContent = `${noteLabel(state.midiB)} · ${midiToHz(state.midiB).toFixed(1)} Hz`;
  const band = bridgeBandHz(state.centre, state.width, midiToHz(state.midiA), state.inharmonicity);
  els.rBridge.textContent = `partial ${band.lowMode}–${band.highMode} ≈ ${band.lowHz.toFixed(0)}–${band.highHz.toFixed(0)} Hz`;
}

function refreshEnergy() {
  const amps = engine.modeAmplitudes();
  const ea = amps.a.reduce((x, y) => x + y * y, 0);
  const eb = amps.b.reduce((x, y) => x + y * y, 0);
  const total = ea + eb;
  if (total < 1e-9) { els.rEA.textContent = '0%'; els.rEB.textContent = '0%'; return; }
  els.rEA.textContent = `${Math.round((ea / total) * 100)}%`;
  els.rEB.textContent = `${Math.round((eb / total) * 100)}%`;
}

let rafId = null;

/** One synchronous repaint of everything the animation would draw. */
function paint() {
  drawLoom();
  drawSpectrum();
  refreshEnergy();
}

function frame() {
  paint();
  rafId = window.requestAnimationFrame(frame);
}

/**
 * Freeze the simulation: stop the render loop and stop the audio thread stepping it.
 *
 * Exposed for the screenshot checks, which need the pixels to be a function of one
 * engine state. Two independent things advance that state and both have to stop.
 *
 * The render loop redraws ~60 times a second, so a shot can land while a canvas is
 * between `clearRect` and the next stroke -- a half-drawn frame.
 *
 * The AudioContext is subtler, and was the real culprit. `onaudioprocess` calls
 * `engine.step()` on Web Audio's render thread, which does not pause synchronously:
 * the callback keeps firing until the context reaches the suspended state. So a
 * check that drove the engine to an exact sample count and then suspended still
 * captured a random number of extra steps -- measured as two distinct trace buffers
 * across otherwise identical runs, ~5% of pixels apart, with the failing viewport
 * varying each time. Setting `state.running = false` makes the callback return early,
 * and polling `audioContextState` confirms the thread has actually stopped before the
 * caller is allowed to drive an exact count.
 */
async function freeze() {
  if (rafId !== null) {
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }
  state.running = false;
  if (audio && audio.state !== 'closed') {
    await audio.suspend();
    while (audio.state === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, 8));
    }
  }
}

export function boot() {
  bind();
  bindCanvas();
  applyTuning();
  refreshReadout();
  window.addEventListener('resize', () => { drawLoom(); drawSpectrum(); });
  window.requestAnimationFrame(frame);
  // Exposed for the browser checks: state, engine, and the two canvases' ids.
  window.harmonicLoom = {
    state, engine, audio, pluck, togglePlay, toggleOverlay, noteLabel, resetForTest, paint, freeze,
  };
}

if (typeof document !== 'undefined' && document.getElementById('loom')) boot();
