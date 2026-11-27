# Harmonic Loom

<!-- Front page image: docs/thumb.png -->

Two real synthesised strings, connected by a bridge that only lets some of their overtones across. Where the energy ends up is drawn live, so you can watch a note leave one string and arrive in the other.

**▶ [Play it now](https://raw.githack.com/thaumapolis/harmonic-loom/main/index.html)** — no install, no network, nothing to build.

*About that link: it is served by [raw.githack.com](https://raw.githack.com), which fetches the committed `index.html` from this repo on GitHub. It needs the network to **load**; once loaded the page asks for nothing else. Opening [`index.html`](index.html) from disk behaves identically and needs no network at all.*

## What you are looking at

Every string here is not one oscillator but a stack of 24 **partials** — the fundamental plus its overtones — each with its own amplitude, phase and decay. That is how a real string behaves, and modelling it that way buys something specific: *which* partials pass from one string to the other becomes a literal property of the signal path rather than something that emerges and has to be inferred afterwards. The picture and the sound read the same state, so they cannot disagree.

The **bridge** is a band on partial number. Only partials inside it can carry energy between the two strings.

- The upper panel is a **6 ms oscilloscope** of each string's own output — the actual samples, not a decorative waveform. Both traces share one vertical scale on purpose: scaling each to its own peak would draw the quiet string as large as the loud one and hide the transfer, which is the whole point.
- The lower panel is a **spectrum**: one bar per partial, green for string A, blue for string B, on a dB scale relative to the loudest partial. The purple column marks the bridge's passband.

## The thing worth checking

Set **Bridge centre** to about 14 with a **narrow Width**, then pluck A.

String B rings, but its fundamental is exactly zero — measured `0.00e+0` over 1.5 s — while the partial sitting at the bridge centre reaches `3.1e-3`. B is sounding a note whose root is missing, because the only route between the strings passes overtones and not the fundamental.

Put the centre back to 1 with a wide width and the opposite happens: B's fundamental climbs to `0.424` against A's `0.424`, i.e. the note crosses almost completely, and then comes back. That swell and fade is beating between two coupled oscillators, and it comes out of the update rule rather than being applied as an effect.

Tune A and B to the same note with **Stiffness** above zero and they still beat slowly, because stiff-string partials are not exact multiples: at the default tuning partial 24 sits at 5459.4 Hz rather than 5280 Hz.

## Controls

| Control | What it does |
| --- | --- |
| **Play** / **Stop** | Starts audio. A is panned left, B right, so the transfer is audible as movement across the stereo field. |
| **Pluck A**, **Pluck B** | Excite one string. You can also drag directly on the scope. |
| **A**, **B** | Pitch of each string, A2–A5. |
| **Bridge centre** | Which partial number passes. 1 = fundamental only; ~14 = fundamental blocked. |
| **Width** | How many partials around the centre get through. |
| **Coupling** | How fast energy crosses. At 0 the strings are independent. |
| **Stiffness** | Real stiff-string inharmonicity: pulls higher partials sharp, so octaves are no longer exact. This is why piano tunings are stretched. |

No sound? The display animates independently of audio, so a muted or blocked AudioContext still shows the transfer.

## How it works

`src/physics.js` holds the domain: partial frequencies `f_k = k·f0·√(1 + B·k²)`, per-mode decay, the triangular pluck spectrum, and the bridge as a Gaussian window over partial index. Nothing is a look-up table of "sounds like X" — every number the UI prints is measured out of this state.

`src/voice.js` runs the synthesis. Each partial is an oscillator in quadrature form and **exactly one place advances its phase**; a second rotation is not a no-op, it is a net gain of e^0.025 per sample at 440 Hz, which overflows to silence.

The bridge is the interesting part. Write the pair as a sum vector `S = A + B` and a difference vector `D = A − B`. A conservative bridge leaves `S` alone and **rotates `D`**, mixing position and quadrature by `2·bridgeWeight(k)·strength`. That is norm-preserving by construction, so energy cannot be created. Two forms were tried and measured before finding it: `a.x += g*b.x` grows the pair as `(1+g)^n` and then NaNs, and rotating each string's own quadrature pair conserves each string's norm while coupling the *sum* — 0.46 to 2.4e5 in 50 samples, and because both strings grew identically it also looked like energy had transferred.

`src/app.js` is the display and controls. `tools/build.mjs` bundles the sources and `src/page.html` into the single `index.html` at the repo root, which is what the preview link serves.

## Building and testing

The app is one file with no dependencies; you only need a toolchain if you want to change it.

```bash
nix develop --command bash -c 'bash tools/check.sh'          # syntax, artifact freshness, unit tests
nix develop --command bash -c 'bash tools/check.sh --browser' # plus headless Chromium + golden screenshots
UPDATE_GOLDEN=1 nix develop --command bash -c 'bash tools/check.sh --browser'  # re-record baselines
```

The unit tests cover the physics and the synth; `tools/browser-check.mjs` loads the built page in headless Chromium at desktop, phone-portrait and phone-landscape sizes and checks that the instrument actually paints, that the mechanism still works when driven through the page rather than through the module, that the onboarding call to action needs no scrolling to reach, and that the rendered frames match committed baselines.

Baselines are compared in the pinned Nix shell so local and CI runs paint on the same Chromium and the same fonts. `tests/golden/` holds one pair of images per viewport, except landscape, where the layout deliberately hides the spectrum to keep the scope on one screen.

Screenshots need a deterministic state. `freeze()` stops the animation loop and suspends the AudioContext, then waits for `ctx.state` to leave `running` — suspending is asynchronous, so Web Audio's render thread otherwise keeps stepping the engine and the captured frame depends on host scheduling.

## Limitations

- Uses `ScriptProcessorNode`, which is deprecated in favour of `AudioWorklet`. It works everywhere this is likely to be opened, but it runs on the main thread and can glitch under load.
- The bridge is a Gaussian window over partial index, which is a plausible shape for a real bridge rather than a model of a specific one. It sets which partials cross; it is not derived from a measured structure.
- The two strings share one pluck position control, and there is no way to hear a single string in isolation without setting coupling to 0.
- Damping is a fixed per-mode law with one scale factor; there is no soundboard, so energy leaves the system rather than being shared with a body.
