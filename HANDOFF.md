# cc-aimassist — engine internals & dev notes

Durable reference for working on this mod: the CrossCode internals it hooks (verified against the
real `game.compiled.js` v1.4.2 and `ultimate-crosscode-typedefs`), how the lock is implemented, and
how to prove changes in the cc-ios macOS harness. User-facing docs live in [`README.md`](README.md).

## Status

**Implemented and on-device, but the feel needs rework (TABLED — see next section).** Lock-on
controller aim assist + two options in the in-game Assists menu. Verified in the cc-ios macOS WebKit
harness: boots with `jsErrors=0`, options register and persist, labels resolve, and a live engine
test confirms the snap re-centers aim onto an enemy with the throw distance preserved and **zero**
spread penalty. Pure aiming math has unit tests (`window.ccAimAssist`). Deployed to the iPhone via the
cc-ios mods overlay and play-tested.

**Real-play verdict:** the current hard snap is too strong/dramatic — only the lowest "Lock Range"
settings feel acceptable. The desired behavior is a *subtle tracking nudge* (help me steer toward an
enemy I'm already aiming at), not a lock-on. The next session should soften the core from a snap to a
gentle, capped pull. Details below.

## Tuning feedback & next steps (TABLED)

The original "lock the center of the spread onto an enemy" framing overshot. What actually feels good
in play is a **gentle nudge that helps track an enemy you're already focusing on** — assistance, not
takeover. Concrete direction for the next session:

1. **Snap → gentle pull.** The hard snap is just `CFG.pull = 1.0`. Lower it (≈ `0.1–0.2`) so the aim
   rotates only a *fraction* of the way to the target each frame, and **re-introduce a per-frame
   degree cap** (the original scaffold's `maxPullDeg`, ≈ `1–3°/frame`) so a far-off target is eased
   toward, never yanked. `nudgeAngle(aim, target, pull)` already supports fractional pull; add the cap
   back around it.
2. **Rethink what the slider controls.** For a tracking nudge, *strength* (how hard it pulls) is the
   useful knob, not cone size. Simplest: rename the `ARRAY_SLIDER` to **"Aim Assist Strength"** and map
   it to a gentle pull range (e.g. `0 → off`, `1 → pull≈0.2 + maxPull≈3°/frame`); keep the engagement
   cone modest and fixed-ish (≈ `12–18°` half-angle) so it only helps for enemies you're basically
   already pointing at. (Keeping a second cone slider is an option but cuts against "keep it simple".)
3. **Keep the spread neutralization** (`_lastDir = snapped offset`). A gentle nudge is small per-frame
   so it usually won't trip the spread penalty anyway, but neutralizing stays correct and keeps spread
   pristine — leave it in.
4. **Consider a small center deadzone** so the assist doesn't fight fine manual corrections when
   you're already dead-on the target.
5. Re-tune defaults after the above (suggested start: cone ≈ 15°, pull ≈ 0.12, maxPull ≈ 2°/frame,
   slider → strength). Re-validate in the harness (unit math + live snap test) and re-deploy.

Because the snap already preserves aim distance and only changes angle, this is a localized change to
`applyAssist`/`CFG` — the hook points, menu wiring, and validation harness all stay as-is.

## Deploying to the device (caution — we lost a save here once)

Installing the mod onto the phone is a `devicectl` copy into the cc-ios app's writable overlay
(`appDataContainer` → `Documents/mods/assets/mods/cc-aimassist/`); the scheme handler auto-merges it
into `mods.json` on launch. No app rebuild needed. **But:**

- **A cc-ios app *reinstall* wipes the whole app container** — `cc.save`, `cc-sync.json`, and installed
  mods all vanish together. If you're also doing cc-ios `make device`/reinstall work in parallel, it
  *will* clear what you pushed. Re-push after any reinstall.
- **The Tailscale save-sync only auto-restores if `Documents/cc-sync.json` exists.** A reinstall
  deletes it, so `SaveSyncClient` silently disables itself and the launch-time pull never runs — the
  save is *not* auto-recovered on the next boot. After any reinstall, re-push `cc-sync.json` (the Mac's
  copy lives at `~/.cc-ios/cc-sync.json`) **before** launching, or the phone boots a fresh save.
- The desktop save (`~/Library/Application Support/CrossCode/Default/cc.save`) is the source of truth
  and is Steam-Cloud backed; the phone never overwrote it during the incident because push needs that
  same `cc-sync.json`. Still: back it up before device work. Durable backups from the incident are in
  `~/.cc-ios/save-rescue-*`.
- These are **cc-ios** gaps (re-push `cc-sync.json` after install; `save-server.py do_PUT` doesn't
  actually enforce newest-wins) — fix them in the cc-ios repo, not here.



## Key decision: a CCLoader `prestart` mod, not native changes

cc-ios is a WKWebView wrapper that already loads **CCLoader** mods, so the phone-compatible *and*
cross-platform way to add aim assist is a **CCLoader mod**, not Swift changes. The same mod runs on
desktop CrossCode (NW.js) and inside cc-ios (WebKit), because it touches only **core engine classes**
— no NW.js/desktop- or iOS-specific APIs. Class hooks must run in the **`prestart`** stage (after
`game.compiled.js` defines `sc.*`); `postload`/`main` are too early/late. The mod **ships no assets**,
so it can never 404 (a fatal error at game init under cc-ios's browser-mode loader).

## CrossCode internals this mod hooks (verified)

Throw aiming flows through the player's crosshair entity and its controller:

- **Player / crosshair:** `ig.game.playerEntity.gui.crosshair` is an `ig.ENTITY.Crosshair`; its
  `controller` is an `sc.PlayerCrossHairController`.
- **Per frame, `ig.ENTITY.Crosshair.deferredUpdate()`:**
  1. `this.controller.updatePos(this)` — sets `crosshair.coll.pos`. In gamepad mode it's
     `throwerPos + lerp(prevOffset, rightStickTarget)`; otherwise it's the mouse→map position.
  2. `a = coll.pos - throwerPos` (raw offset vector); `b = Vec2.angle(a, this._lastDir)`.
     If `!special && b > 2*maxAngleMove` (`maxAngleMove = PI/128` ≈ 1.4°), it **widens the spread**:
     `rangeCurrent += b/2 * (1 - AIM_STABILITY)`. (This is the "your aim got knocked off" penalty.)
  3. `_lastDir = a; _aimDir = a`.
- **Aim direction = `normalize(coll.pos - throwerPos)`; throw distance/range = `|coll.pos - throwerPos|`.**
- **Spread output:** `getThrowDir(v)` returns `_aimDir` rotated by a random `±rangeCurrent/2`. Each
  frame `rangeCurrent` also **decays** (lines tighten to a point) unless the penalty above re-grows it.
  `getThrowDir`'s result becomes `player.throwDir`, which is consumed as a **direction** (assigned to
  `this.face`) — so only its angle matters to the throw, not its magnitude.
- **Gamepad gate:** `controller.gamepadMode` is latched true at aim-start if the right stick was down
  (`sc.control.isRightStickDown()`); mouse aiming keeps it false.
- **Enemies:** scan `ig.game.entities` for `e.isCombatant === true && e.party ===
  sc.COMBATANT_PARTY.ENEMY` (`PLAYER=1, ENEMY=2, OTHER=3`) and `!e.isDefeated()`; position via
  `e.getCenter(vec)`.

There is **no pre-existing gamepad auto-aim** in CrossCode to coexist with.

## How the lock is implemented (current behavior — to be softened; see "Tuning feedback")

> The current build does a **hard snap** (`CFG.pull = 1.0`). Play-testing says that's too dramatic;
> the next session should turn this into a gentle, per-frame-capped pull (see the tabled tuning
> section above). The hook points below stay the same — only the pull strength/cap and the slider
> semantics change.

Inject `sc.PlayerCrossHairController.updatePos`. After `this.parent(crosshair)` (so the game has
already positioned the crosshair from the stick):

1. Gate: enabled option on, `controller.gamepadMode`, `crosshair.active`, slider cone > 0.
2. Find the alive enemy whose **angle** from the thrower is nearest the current aim, within the
   slider-controlled cone (with a `*1.5` release cone for hysteresis on the held target).
3. **Snap:** rotate `coll.pos` to point exactly at that enemy while **preserving `|offset|`** (throw
   range/speed unchanged — only the angle changes).
4. **Neutralize the spread penalty:** set `crosshair._lastDir` to the snapped offset, so step (2) of
   `deferredUpdate` sees `b ≈ 0` and never grows `rangeCurrent` from the snap. The normal per-frame
   decay still runs, so the spread still tightens to a line — now centered on the enemy.

Why this satisfies "don't affect the spread": the only thing the snap changes is the aim *angle*; it
never feeds the spread-growth path, and it preserves the offset magnitude the throw uses. Tunables
(`maxConeDeg`, `rangePx`, `releaseFactor`, `pull`) live in `CFG` at the top of `prestart.js`.

## Assists-menu integration

- Register two entries in `sc.OPTIONS_DEFINITION` at `prestart` (so the option model picks up their
  `init` defaults and persists them):
  - `aim-assist-enabled` — `CHECKBOX`, `init: true`, `cat: sc.OPTION_CATEGORY.ASSISTS`, `header:
    "aimAssist"`, `hasDivider: true` (the header text is what creates the new "Aim Assist" section).
  - `aim-assist-strength` — `ARRAY_SLIDER`, `data: [0, 1]`, `init: 0.5`, `cat: ASSISTS`, `fill: true`
    (a continuous 0–100% slider; `strength → cone half-angle`).
- **Labels:** inject `ig.Lang.get` to return our strings for `sc.gui.options.headers.aimAssist` and
  `sc.gui.options.aim-assist-*.name` / `.description`, delegating every other key to `this.parent`.
- **Read live:** `sc.options.get("aim-assist-enabled")` / `get("aim-assist-strength")`.

The shapes mirror the game's own assists options (`assist-damage`, `assist-puzzle-speed`, …), and the
option model builds menu rows by iterating `OPTIONS_DEFINITION` filtered by `cat` — so our entries
render as a normal section.

## Verifying in the cc-ios macOS harness (local, no device)

From a cc-ios checkout with assets synced (`tools/sync-assets.sh`) and CCLoader + this mod installed
(`tools/setup-ccloader.sh [--add-mod …]`):

```bash
swift build
./.build/debug/webkit-harness --root app/Resources/game --entry ccloader/index.html \
  --prefer-m4a --mods-overlay /tmp/cc-overlay --timeout 120 \
  --eval '(function(){return JSON.stringify({
     enabled: sc.options.get("aim-assist-enabled"),
     strength: sc.options.get("aim-assist-strength"),
     header: ig.lang.get("sc.gui.options.headers.aimAssist"),
     ctrl: typeof sc.PlayerCrossHairController.prototype.updatePos
  });})()'
```

Notes:
- `--eval` runs at the **title screen** (`ig.game.playerEntity` is null there), and `--poke` is
  ignored when `--eval` is set. Static class probes and synthetic tests work fine at the title:
  construct a real `new sc.PlayerCrossHairController()`, a stub crosshair (`coll.pos`, `_lastDir`,
  `_getThrowerPos`), and temporarily set `ig.game.entities` to a fake enemy to exercise the injected
  `updatePos`. Use synchronous code only (returning a Promise isn't supported).
- The pure math (`window.ccAimAssist.selectTarget` / `coneRadFor` / `nudgeAngle`) can be unit-tested
  in plain Node by loading `prestart.js` with stubbed `window`/`sc`/`ig` globals.
- Success line: `bootstrap=true platform=Browser jsErrors=0`.
- Headless caveat: the title→options menu *visual* transition doesn't always paint in the harness,
  but the option model still selects the Assists tab without error — verify the menu by data
  (`OPTIONS_DEFINITION` ordering + `ig.lang.get`) rather than a screenshot.

## Packaging

`tools/build-ccmod.sh` stages the root mod files into `dist/<id>-<version>.ccmod` (manifest at the
archive root; `prestart.js` syntax-checked first). The same `.ccmod` installs on desktop CCLoader and
cc-ios. Built artifacts (`*.ccmod`, `dist/`) are git-ignored.

## Conventions

- **Commits:** privacy-preserving GitHub `noreply` identity (never a corporate email);
  [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`,
  scopes like `feat(mod):`).
- **JS:** no `any` in TS; narrow `unknown`. Comment only the non-obvious. Keep the hook in `try/catch`.
- **Never commit CrossCode assets** (copyrighted; BYO copy) or personal/machine data.
