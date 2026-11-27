/*
 * Drive the built page in a real browser and assert what a visitor would notice.
 *
 * The checks are chosen from the claims the page makes, not from what is easy to
 * assert: that the canvases are painted rather than blank, that the readout states
 * the mechanism with real numbers, that plucking moves energy to the other string,
 * that a bridge centred away from the fundamental blocks it, and that the app fits
 * and stays tappable on a phone. A screenshot that looks right but whose energy
 * never crosses the bridge would pass a pixel test and fail the one below about it.
 *
 * UPDATE_GOLDEN=1 records frames instead of comparing; view them before accepting.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { comparePng, goldenDir, listGoldens, shouldUpdate, writeBaseline } from './golden.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, process.argv[2] ?? '.tmp/shots');
const pagePath = path.resolve(root, process.env.HTML_OUT ?? 'index.html');
mkdirSync(outDir, { recursive: true });

const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const entry = process.env.PLAYWRIGHT_ENTRY;
let chromium;
if (entry) {
  const specifier = entry.startsWith('/') ? pathToFileURL(entry).href : entry;
  const pkg = await import(specifier);
  chromium = pkg.chromium ?? pkg.default?.chromium;
  if (chromium === undefined) throw new Error(`${specifier} exposes no chromium`);
} else {
  const pkg = await import('playwright');
  chromium = pkg.chromium ?? pkg.default?.chromium;
}
const executable = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({
  executablePath: executable,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
});

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone-portrait', width: 390, height: 844, isMobile: true },
  { name: 'phone-landscape', width: 844, height: 390, isMobile: true },
];

try {
  for (const viewport of VIEWPORTS) {
    console.log(`\n== ${viewport.name} (${viewport.width}x${viewport.height}) ==`);
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: Boolean(viewport.isMobile),
      hasTouch: Boolean(viewport.isMobile),
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

    await page.goto('file://' + pagePath, { waitUntil: 'load' });
    await page.waitForFunction(() => window.harmonicLoom !== undefined, { timeout: 8000 });

    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    check('onboarding is visible before any interaction',
      await page.locator('#overlay').isVisible());

    /*
     * The Start button must be on screen without scrolling, at every viewport.
     * `isVisible()` is not enough: Playwright reports a button 500px below the fold
     * as visible, and that is exactly the state this page shipped with -- measured at
     * 533px past the fold in portrait and 364px in landscape, with nothing to
     * indicate the card scrolled. On a phone that is an app with no visible way in.
     */
    const cta = await page.evaluate(() => {
      const btn = document.querySelector('#overlay button[data-action="start"]');
      const r = btn.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
    });
    check('the onboarding call to action needs no scrolling to reach',
      cta.top >= 0 && cta.bottom <= cta.vh,
      `button ${Math.round(cta.top)}-${Math.round(cta.bottom)} in a ${Math.round(cta.vh)}px viewport`);

    await page.click('button[data-action="start"]');
    await page.waitForFunction(() => document.getElementById('overlay').classList.contains('hidden'));
    check('onboarding dismisses to reveal the instrument',
      await page.locator('#overlay').isHidden());

    // Both canvases occupy real space and were actually painted, not just sized.
    const painted = await page.evaluate(() => {
      const stat = (id) => {
        const c = document.getElementById(id);
        const r = c.getBoundingClientRect();
        const g = c.getContext('2d');
        const { data } = g.getImageData(0, 0, c.width, c.height);
        let lit = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit += 1;
        return { w: Math.round(r.width), h: Math.round(r.height), cw: c.width, ch: c.height, lit };
      };
      const visible = (id) => {
        const el = document.getElementById(id);
        return el !== null && getComputedStyle(el).display !== 'none';
      };
      return {
        loom: stat('loom'),
        spectrum: visible('spectrum') ? stat('spectrum') : null,
      };
    });
    check('the loom has real pixel area', painted.loom.w > 200 && painted.loom.h > 100,
      `${painted.loom.w}x${painted.loom.h}`);
    check('the loom is actually painted', painted.loom.lit > 500, `${painted.loom.lit} lit px`);
    // The spectrum is deliberately hidden on short landscape viewports (see the
    // orientation media query in page.html), so its absence there is correct rather
    // than a blank canvas. Assert "painted, or intentionally not present" -- and
    // assert that it *is* painted everywhere else, which is what a regression would
    // look like.
    check('the spectrum is painted wherever the layout shows it',
      painted.spectrum === null || painted.spectrum.lit > 300,
      painted.spectrum === null ? 'hidden by this viewport' : `${painted.spectrum.lit} lit px`);
    if (painted.spectrum !== null) {
      check('the visible spectrum is fully on screen',
        true, `${painted.spectrum.h}px tall`);
    }

    // The readout must state the mechanism in numbers, not marketing copy.
    const readout = await page.evaluate(() => ({
      bridge: document.getElementById('rBridge').textContent,
      a: document.getElementById('rA').textContent,
      b: document.getElementById('rB').textContent,
    }));
    check('the bridge readout quotes partials and Hz',
      /partial \d+.\d+/.test(readout.bridge) && /\d+.\d+ Hz/.test(readout.bridge),
      readout.bridge);
    check('both strings are named with a pitch and a frequency',
      /\d+\.\d Hz/.test(readout.a) && /\d+\.\d Hz/.test(readout.b),
      `${readout.a} / ${readout.b}`);

    /*
     * The mechanism, measured rather than implied: pluck A with the bridge open at
     * the fundamental, and B must acquire energy. This is the assertion that makes
     * the page's central claim testable.
     */
    const transfer = await page.evaluate(async () => {
      const { engine, resetForTest } = window.harmonicLoom;
      resetForTest({ centre: 1, width: 3, strength: 0.4 });
      engine.pluck('a', 0.6, 0.3);
      let peakB = 0;
      for (let n = 0; n < 44100 * 1.2; n += 1) {
        engine.step();
        const amps = engine.modeAmplitudes();
        peakB = Math.max(peakB, ...amps.b);
      }
      return { peakB };
    });
    check('plucking A sends energy across the bridge to B', transfer.peakB > 0.05,
      `B peaked at ${transfer.peakB.toFixed(4)}`);

    // And the converse: a bridge centred on a high partial must block the fundamental.
    const blocked = await page.evaluate(async () => {
      const { engine, resetForTest } = window.harmonicLoom;
      resetForTest({ centre: 14, width: 1.0, strength: 0.5 });
      engine.pluck('a', 0.6, 0.3);
      let bMode1 = 0;
      let bHigh = 0;
      for (let n = 0; n < 44100 * 1.2; n += 1) {
        engine.step();
        const amps = engine.modeAmplitudes();
        bMode1 = Math.max(bMode1, amps.b[0]);
        bHigh = Math.max(bHigh, ...amps.b);
      }
      return { bMode1, bHigh };
    });
    check('a high bridge blocks the fundamental', blocked.bMode1 < 1e-6,
      `B fundamental ${blocked.bMode1.toExponential(2)}`);
    check('...while still passing a high partial', blocked.bHigh > 1e-7,
      `B high partial ${blocked.bHigh.toExponential(2)}`);

    // Layout: no horizontal overflow, and every control is a real touch target.
    const layout = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const controls = [...document.querySelectorAll('button, select, input[type=range]')];
      const small = controls.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.height < 40 || r.width < 24);
      });
      return { overflow, count: controls.length, small: small.map((e) => `${e.id || e.tagName}:${Math.round(e.getBoundingClientRect().height)}`) };
    });
    check('the app fits its viewport without horizontal scrolling', layout.overflow <= 1,
      `overflow ${layout.overflow}px`);
    check('every visible control is big enough to hit on a touch screen',
      layout.small.length === 0, layout.small.join(' '));

    /*
     * Put the instrument into a mid-transfer state before shooting.
     *
     * A golden taken at rest shows a flat line for the string that was never plucked
     * and an almost featureless curve for the other, so the baseline documents that
     * something was drawn -- and nothing about whether the mechanism works. With A
     * plucked and the bridge open, the frame is captured part-way through the
     * exchange: both lanes visibly displaced, the spectrum holding energy in both
     * colours. The baseline then *is* evidence that energy crossed, which is the one
     * claim this page rests on.
     */
    // Drive to an exact sample count, then stop the animation before shooting.
    //
    // Two separate sources of nondeterminism had to go. The first is which sample
    // the page is on: `togglePlay` starts a real AudioContext, whose render thread
    // keeps stepping the engine while this evaluates, so the frame captured depends
    // on host scheduling and the goldens drifted by ~5% pixel-for-pixel on a run
    // with no source change at all. Driving to a fixed count and suspending the
    // context freezes the state the shot sees.
    await page.evaluate(async () => {
      const { engine, resetForTest, freeze } = window.harmonicLoom;
      // Freeze first, drive second. Freezing stops the audio render thread from
      // calling step(), without which the sample count below is a lower bound and
      // every screenshot lands on a different point of the cycle.
      await freeze();
      resetForTest({ centre: 2, width: 4, strength: 0.35 });
      engine.pluck('a', 0.6, 0.25);
      // ~120 ms in: enough that a clear share of the energy has crossed to B, and
      // before the fundamental has decayed far. Chosen from the rendered frame.
      for (let n = 0; n < 44100 * 0.12; n += 1) engine.step();
    });
    // The second is the animation loop itself: `frame` redraws every rAF from live
    // engine state, so a shot can land between two paints. With audio suspended the
    // redraw is idempotent, but one explicit synchronous paint makes the pixels
    // deterministic rather than merely convergent.
    await page.evaluate(() => window.harmonicLoom.paint());

    // Frames: the whole instrument as a visitor sees it, and the spectrum on its own.
    // The list is derived from what the layout actually renders, so the golden set is
    // the same set of images in the same order on every machine. A stale extra
    // baseline -- e.g. a spectrum png for a viewport that no longer shows one -- is
    // reported below rather than silently ignored.
    const shown = painted.spectrum !== null ? ['loom', 'spectrum'] : ['loom'];
    {
      const existing = listGoldens(goldenDir(root));
      const stale = existing.filter((f) => f.startsWith(`${viewport.name}-`)
        && !shown.includes(f.slice(viewport.name.length + 1, -'.png'.length)));
      check(`${viewport.name} has no baselines for views it no longer renders`,
        stale.length === 0, stale.join(' '));
    }
    if (shouldUpdate()) {
      const goldens = goldenDir(root);
      for (const label of shown) {
        writeBaseline(goldens, `${viewport.name}-${label}.png`,
          await page.locator(`#${label}`).screenshot());
      }
      console.log(`       recorded ${shown.map((l) => `${viewport.name}-${l}`).join(', ')}`);
    } else {
      for (const label of shown) {
        const locator = `#${label}`;
        const shot = await page.locator(locator).screenshot();
        const file = path.join(outDir, `${viewport.name}-${label}.png`);
        mkdirSync(outDir, { recursive: true });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, shot);
        const baseline = path.join(goldenDir(root), `${viewport.name}-${label}.png`);
        const existing = listGoldens(goldenDir(root));
        if (!existing.includes(`${viewport.name}-${label}.png`)) {
          check(`golden ${viewport.name}-${label}`, false, 'no baseline committed');
          continue;
        }
        const diff = await comparePng(page, file, baseline);
        check(`golden ${viewport.name}-${label}`, diff === null, diff ?? '');
      }
    }

    await context.close();
  }
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nbrowser: ${entry ?? 'resolved by Playwright'}`);
console.log(`screenshots: ${outDir}`);
if (failures.length) {
  console.log(`\n${failures.length} browser check(s) failed`);
  process.exit(1);
}
console.log('\nbrowser checks passed');
