# cc-aimassist

Very gentle **controller aim assist** for **[CrossCode](https://store.steampowered.com/app/368340/CrossCode/)**,
delivered as a **CCLoader mod** so it works on desktop *and* on iPhone/iPad via
**[cc-ios](https://github.com/cc-mods/cc-ios)**.

> ### ⚠️ You must own CrossCode. This repo contains **no game code or assets** — only a small mod.

When you aim with an analog stick and point **close enough** to an enemy, the **center of your throw
aim locks onto that enemy**. It's a nudge toward playability on a tiny controller — a lock, not a
take-over — and it deliberately leaves the game's bullet-spread mechanic untouched: your shots still
tighten to a line exactly as before, that line is just re-centered on the enemy.

## Settings (in-game Assists menu)

Open **Options → Assists**. The mod adds an **Aim Assist** section:

| Setting | What it does |
|---|---|
| **Enable Aim Assist** | Toggles the lock on/off. |
| **Lock Range** | How close to an enemy you must aim for the lock to engage. Higher = locks on from a wider angle; **0% turns the lock off**. |

Settings persist with your other options. Defaults: enabled, Lock Range 50%.

## How it works

A **pure-logic CCLoader mod** (ships no assets) that hooks CrossCode's gamepad aiming in the
`prestart` stage. Each frame, while you're aiming with the right stick, it looks for the alive enemy
nearest to your aim *angle* within the Lock-Range cone and rotates the crosshair to point exactly at
it — **preserving the aim distance**, so throw range/speed is identical to vanilla; only the angle
changes. It then tells the spread system "nothing moved this frame," so the snap can never widen your
spread; the spread's normal per-frame tightening still runs, so the cone still narrows to a line —
now centered on the enemy. A small hysteresis (release cone) keeps the lock from flickering between
two nearby enemies.

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
  prestart.js              the hook (lock-on aim assist + Assists-menu options)
  icon.png                 24x24 mod icon (original art)
  README.md
  HANDOFF.md               engine internals this mod hooks + dev/harness notes
  LICENSE                  MIT (this mod's own code only)
  tools/build-ccmod.sh     package the mod into a distributable .ccmod
  .github/workflows/release.yml   auto-release on push to main
```

## Development

The mod is a single `prestart.js`. The pure aiming math is exported on `window.ccAimAssist` for
testing, and the whole hook is wrapped in `try/catch` so a mod error can never reach game init.

Prove changes the same way cc-ios does — in the **macOS WebKit harness** (local, no device, no
signing). From a cc-ios checkout with assets synced + this mod added:

```bash
swift build
./.build/debug/webkit-harness --root app/Resources/game --entry ccloader/index.html \
  --prefer-m4a --mods-overlay /tmp/cc-overlay --timeout 120 \
  --eval '(function(){return "enabled="+sc.options.get("aim-assist-enabled");})()'
```

Success looks like `bootstrap=true platform=Browser jsErrors=0`. See [`HANDOFF.md`](HANDOFF.md) for the
verified class/method internals and more probes.

## Legal

Unofficial fan project, **not affiliated with, authorized, or endorsed by Radical Fish Games**.
Contains no CrossCode code or assets. This mod's own source is MIT (see [`LICENSE`](LICENSE)).
CrossCode and [CCLoader](https://github.com/CCDirectLink/CCLoader) belong to their respective owners.
