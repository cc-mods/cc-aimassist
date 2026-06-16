# cc-aimassist

Very gentle **controller aim assist** for **[CrossCode](https://store.steampowered.com/app/368340/CrossCode/)**,
delivered as a **CCLoader mod** so it works on desktop *and* on iPhone/iPad via
**[cc-ios](https://github.com/cc-mods/cc-ios)**.

> ### ⚠️ You must own CrossCode. This repo contains **no game code or assets** — only a small mod.

While you aim with an analog stick, the mod helps you point at a nearby **enemy** — and **only** enemies
(never NPCs, props, or destructibles). Choose **one** behavior and tune it: **Friction** (slow your aim
near an enemy), **Track** (gently follow the enemy you're aiming at — the default), **Hybrid** (both),
**Sticky** (glue your aim to the target so it follows their movement), or **Lock** (snap). It's a nudge
toward playability on a tiny controller — assistance, not take-over — and it deliberately leaves the
game's bullet-spread mechanic untouched: your shots still tighten to a line exactly as before, that line
is just better aimed.

## Settings (in-game Assists menu)

Open **Options → Assists**. The mod adds an **Aim Assist** section:

| Setting | What it does |
|---|---|
| **Aim Assist** | Pick **one**: **Off** / **Friction** / **Track** / **Hybrid** / **Sticky** / **Lock**. *Friction* slows your aim's motion near an enemy so it's easier to hold. *Track* (default) gently eases your aim to follow an enemy you're pointing at — waits a moment before engaging (**Engage Delay**), **never snaps**. *Hybrid* does both (slow **and** pull). *Sticky* partly glues your aim to the target so it follows the enemy's movement; your stick still steers. *Lock* snaps straight onto the nearest enemy. |
| **Strength** | How hard *Track*/*Hybrid* pull, how much *Friction* slows, or how glued *Sticky* is. (*Lock* always snaps.) **0% = no help** for the pull/slow/glue modes. |
| **Range** | The engagement cone — how close to an enemy you must aim before any assist kicks in. Lower is tighter (only when you're nearly on them); higher helps from a wider angle. |
| **Engage Delay** | How long you must hold aim near an enemy before it engages. **0% = instant**; higher makes it wait, so sweeping the stick past enemies won't grab them. |
| **Max Distance** | How far away an enemy can be and still be assisted. |
| **Deadzone** | When you're already nearly dead-on, *Track*/*Hybrid* back off so they don't fight your fine aiming. |
| **Lead Targets** | Aim where a moving enemy is **heading** rather than where they are now (helps *Track*, *Hybrid*, *Sticky* and *Lock* hit enemies that strafe). |

Only **one** mode is active at a time (it's a single-select). Everything is tunable live in the menu so
you can dial in the feel on any device — no rebuild needed. Settings persist with your other options.
Defaults: **Track**, Strength 50%, Range 40% (~14°), Engage Delay 50% (~160 ms), Max Distance 50%
(600 px), Deadzone 40% (~1.6°), Lead off.

## How it works

A **pure-logic CCLoader mod** (ships no assets) that hooks CrossCode's gamepad aiming in the
`prestart` stage. Each frame, while you're aiming with the right stick, it finds the alive **enemy**
nearest to your aim *angle* within the **Range** cone (preferring the closer one on a tie, with a
release cone so the target doesn't flicker, and only enemies within **Max Distance**), then — depending
on the mode — damps your stick's motion near it (**Friction**), eases your aim toward it (**Track**, a
fractional per-frame pull capped so it tracks but never yanks, gated by the **Engage Delay** dwell and a
center **Deadzone**), does both (**Hybrid**), partly glues your aim to the target so it auto-follows
(**Sticky**), or snaps onto it (**Lock**). With **Lead Targets** on, it aims at the enemy's *predicted*
position from their velocity. It always **preserves the aim distance**, so throw range/speed
is identical to vanilla; only the angle changes. It then tells the spread system "nothing moved this
frame," so the assist can never widen your spread; the spread's normal per-frame tightening still runs,
so the cone still narrows to a line — now better aimed.

It relies only on core engine classes (no NW.js- or iOS-specific APIs), which is why the same mod
runs on desktop CrossCode and inside the cc-ios WebKit wrapper. Shipping no assets also means there's
nothing to 404 — the safest kind of mod for the browser-mode loader cc-ios uses. See
[`HANDOFF.md`](HANDOFF.md) for the exact engine internals it hooks.

## Install

> **One-click:** part of the [**cc-mods**](https://github.com/cc-mods) suite. On the
> [**cc-ios**](https://github.com/cc-mods/cc-ios) iPhone wrapper it appears in the in-game **Mods**
> tab automatically. On desktop, add the `@cc-mods/CCModDB/stable` repository in CCModManager →
> Settings → Repositories, or grab the `.ccmod` from
> [Releases](https://github.com/cc-mods/cc-aimassist/releases).

### Desktop CrossCode (with CCLoader)

1. Install **[CCLoader 2.x](https://github.com/CCDirectLink/CCLoader)** if you haven't.
2. Grab the `.ccmod` from [Releases](https://github.com/cc-mods/cc-aimassist/releases) (or build it
   locally with `tools/build-ccmod.sh`, which writes `dist/cc-aimassist-<version>.ccmod`).
   Copy that `.ccmod` into `CrossCode/assets/mods/` (CCLoader unpacks it), or install it from the
   in-game **CCModManager**. You can also just copy this repo's mod files into
   `CrossCode/assets/mods/cc-aimassist/`.
3. Launch CrossCode. Confirm `[cc-aimassist] loaded` in the dev console.

### iPhone / iPad (cc-ios)

cc-ios already loads CCLoader mods (in-game **Mods** tab + on-device install). From a cc-ios
checkout (after `make setup`):

```bash
tools/setup-ccloader.sh --add-mod /path/to/cc-aimassist
```

…or install the built `.ccmod` from the in-game **Mods** tab. Then boot and check the JS console for
`[cc-aimassist] loaded`.

## Repo layout

```
cc-aimassist/
  ccmod.json               CCLoader manifest (prestart stage, no assets)
  package.json             legacy CCLoader manifest mirror
  prestart.js              the hook (Friction/Track/Hybrid/Sticky/Lock aim assist + Assists-menu options)
  icon.png                 24x24 mod icon (original art)
  README.md
  HANDOFF.md               engine internals this mod hooks + dev/test notes
  LICENSE                  MIT (this mod's own code only)
  test/aim-math.test.js    Node unit tests — pure aiming math + slider mappings (no game, no deps)
  test/aim-sim.test.js     Node integration test — drives applyAssist per-frame for every mode (headless)
  tools/build-ccmod.sh     package the mod into a distributable .ccmod
  .github/workflows/release.yml   auto-release on push to main
```

## Development

The mod is a single `prestart.js`. The pure aiming math **and** the per-frame assist logic are exported
on `window.ccAimAssist`, with two **fully headless** Node test suites (no game, no browser, no window):

```bash
npm test                       # runs both suites
# or individually:
node test/aim-math.test.js     # pure math + slider->tunable mappings
node test/aim-sim.test.js      # drives the real applyAssist frame-by-frame for every mode
```

`aim-sim.test.js` stubs `sc`/`ig` and simulates the aim loop, so it exercises mode dispatch, target
selection, dwell, deadzone, Lead, range/distance gating, and the spread-neutralization — the same things
the old WKWebView harness checked, but without opening a window.

The whole hook is wrapped in `try/catch` so a mod error can never reach game init. If you *do* want a
full in-engine smoke test, the cc-ios **macOS WebKit harness** still works (it boots a WKWebView, so it
opens a window) — see [`HANDOFF.md`](HANDOFF.md) for the probe. Success looks like
`bootstrap=true platform=Browser jsErrors=0`.

## Legal

Unofficial fan project, **not affiliated with, authorized, or endorsed by Radical Fish Games**.
Contains no CrossCode code or assets. This mod's own source is MIT (see [`LICENSE`](LICENSE)).
CrossCode and [CCLoader](https://github.com/CCDirectLink/CCLoader) belong to their respective owners.
