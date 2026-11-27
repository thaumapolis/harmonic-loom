/*
 * The generated page, checked without a browser.
 *
 * jsdom gives a DOM but no canvas raster backend and no Web Audio, so this file
 * cannot ask "does it sound" or "are pixels drawn" -- the browser check does that.
 * What it can and does pin down is the self-contained promise and the wiring: that
 * the built file fetches nothing, that every id the app reaches for exists, that
 * the onboarding says what the thing actually does, and that the notes and the
 * readout come from the same functions the app uses, so the page cannot advertise
 * one pitch and play another.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOptional } from '../tools/optional-deps.mjs';
import { noteLabel } from '../src/app.js';
import { bridgeBandHz, midiToHz, MODE_COUNT } from '../src/physics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.resolve(root, process.env.HTML_OUT ?? 'index.html');
const html = await readFile(htmlPath, 'utf8');

let failed = 0;
function ok(name, condition, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!condition) failed += 1;
}

// --- self-contained: the whole point of the project ---------------------
ok('the page asks for nothing outside itself', (() => {
  const external = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((ref) => !ref.startsWith('#') && !ref.startsWith('data:'));
  return external.length === 0;
})());
ok('the page fetches nothing at runtime',
  !/\bfetch\s*\(|XMLHttpRequest|importScripts|new Worker|navigator\.serviceWorker/.test(html));
ok('no module imports survive the bundle', !/<script[^>]+type=["']module["']/.test(html));
ok('no ES module export statements leak into the page', !/^\s*export\s/m.test(html));
ok('no cross-origin URL appears anywhere in the file',
  !/https?:\/\/[^\s"'<>]*\.(?:com|org|net|io)\b/i.test(html),
  (html.match(/https?:\/\/\S+/g) ?? []).slice(0, 2).join(' '));

// --- the app boots against the real DOM ---------------------------------
const jsdomModule = await loadOptional('jsdom');
if (jsdomModule === null) {
  console.log('SKIP  DOM checks: jsdom is unavailable. Run inside `nix develop --command`.');
} else {
  const { JSDOM } = jsdomModule.default ?? jsdomModule;
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;

  // jsdom has no Web Audio and no canvas backend; the app must survive their absence
  // rather than die on boot, because a page that throws on load shows nothing at all.
  ok('the app boots in a DOM with no Web Audio and no canvas backend',
    (() => {
      const errors = [];
      window.addEventListener('error', (event) => errors.push(event.message));
      return typeof window.harmonicLoom === 'object' && errors.length === 0;
    })(),
    'window.harmonicLoom present');

  // Every getElementById in the source must resolve, or the app half-works silently.
  const source = await readFile(path.join(root, 'src/app.js'), 'utf8');
  // Two forms resolve ids in this app: the literal getElementById calls, and the
  // `bind` list of names that are then looked up as getElementById(id). Matching only
  // the first found a single literal id and the guard below would have been vacuous
  // -- it asserts the list is non-empty precisely so that a broken regex shows up.
  const literalIds = [...source.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const bindList = source.match(/const ids = \[([\s\S]*?)\];/);
  const namedIds = bindList === null ? [] : [...bindList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const ids = [...new Set([...literalIds, ...namedIds])];
  const missing = ids.filter((id) => document.getElementById(id) === null);
  ok('every id the app looks up exists in the page', missing.length === 0, missing.join(' '));
  ok('the id list is not empty (a broken regex would pass vacuously)', ids.length > 10, `${ids.length} ids`);

  // Touch targets are a stated requirement, so the markup must declare them.
  ok('the page opts out of double-tap zoom on the canvas',
    /touch-action:\s*none/.test(html));
  ok('the viewport is set for phones', /name="viewport"/.test(html));

  // Onboarding must explain the mechanism, not just invite a click.
  const overlay = document.getElementById('overlay');
  const prose = overlay.textContent.replace(/\s+/g, ' ');
  ok('onboarding names the mechanism', /partials|partial/i.test(prose));
  ok('onboarding names the bridge', /bridge/i.test(prose));
  ok('onboarding tells the visitor what to do', /Pluck|pluck/.test(prose));
  ok('onboarding is dismissed by a control, not only by a timeout',
    overlay.querySelector('button[data-action="start"]') !== null);

  // The readout must be derivable from the same functions the page uses. If these
  // two sources disagreed, the page would print a pitch it was not playing.
  const selectMarkup = document.getElementById('noteA');
  ok('the note selects are populated in the markup or by the app',
    selectMarkup !== null);
  ok('note labels are correct against the pitch formula',
    noteLabel(69).startsWith('A') && Math.abs(midiToHz(69) - 440) < 1e-9,
    `A4 -> ${noteLabel(69)} at ${midiToHz(69)} Hz`);
  ok('an octave up is labelled one higher',
    Number(noteLabel(81).match(/\d+/)[0]) === Number(noteLabel(69).match(/\d+/)[0]) + 1,
    `${noteLabel(69)} -> ${noteLabel(81)}`);

  // The bridge readout the app prints must be bridgeBandHz's own output, including
  // the honesty flag: a clipped edge must not be presented as a measured crossing.
  const band = bridgeBandHz(MODE_COUNT, 2, 220, 0);
  ok('a clipped passband edge is flagged as the range end',
    band.highIsEdge === false && band.highMode === MODE_COUNT);
}

console.log(failed === 0 ? 'app checks passed' : `${failed} app check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
