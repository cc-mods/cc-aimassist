# cc-aimassist — engine internals & dev notes

Durable reference for working on this mod: the CrossCode internals it hooks (verified against the
real `game.compiled.js` v1.4.2 and `ultimate-crosscode-typedefs`), how the lock is implemented, and
how to prove changes in the cc-ios macOS harness. User-facing docs live in [`README.md`](README.md).

## Status

**Reworked into selectable, gentle tracking assists (the snap is now opt-in).** Controller aim assist
with **six single-select modes** — Off / Friction / Track (default) / Hybrid / Sticky / Lock — plus a
**Lead Targets** prediction toggle, exposed in the in-game Assists menu as a `BUTTON_GROUP` (mode) + five
`ARRAY_SLIDER`s (Strength, Range, Engage Delay, Max Distance, Deadzone) + a `CHECKBOX` (Lead). Everything
is **live-tunable on-device** (no rebuild); only one mode runs at a time. Verified **fully headlessly**:
pure math + slider→tunable mappings (`test/aim-math.test.js`) and the real `applyAssist` driven
frame-by-frame for every mode (`test/aim-sim.test.js`) — `npm test` runs both (71 cases), no browser.
Targets **only alive enemy combatants** and never feeds the bullet-spread growth path.

**Why the rework:** the original build was a hard snap (`CFG.pull = 1.0`) on a wide cone with no
engagement delay — real-play verdict was "too strong/dramatic; only the lowest range felt OK," and it
felt like it grabbed the "wrong" target when sweeping the stick. The fix follows the industry-standard
stack for 2D tracking assists (angle-based selection + hysteresis you already had, plus capped angular
gravity, a dwell delay, and a center deadzone). The old snap survives as the opt-in **Lock** mode.

## Modes & tuning (implemented)

The Assists menu exposes a **mode** (`BUTTON_GROUP`) plus five sliders + a checkbox; each 0–1 slider maps
onto a range set by constants in `CFG` at the top of `prestart.js` (pure mapping fns: `coneRadFor`,
`distPxFor`, `dwellFramesFor`, `deadzoneRadFor`, `pullFor`, `capRadFor`, `frictionFor`, `stickyFollowFor`
— all unit-tested). Per-mode behavior in `applyAssist`:

1. **Friction** — *aim slowdown*. Near a target, keep only `1 - f` of the stick's per-frame angular
   motion (`frictionStep`, `f = frictionFor(strength) × blend`). Never moves your aim for you.
2. **Track (default)** — *capped angular gravity*. Ease aim toward the target by `pullFor(strength)`
   (fraction/frame), clamped to `capRadFor(strength)` (deg/frame) so a far target is eased toward, never
   yanked (`trackStep`). Gated by a **dwell ramp** (`dwellFramesFor(delay)`; `blend` 0→1) that **resets
   when you acquire a new enemy**, so sweeping the stick through a crowd never grabs intermediate
   targets. A center **Deadzone** (`deadzoneRadFor`) makes it hands-off when you're already dead-on.
3. **Hybrid** — Friction **then** Track: `frictionStep` (×`hybridFrictionScale`) damps the stick, then
   `trackStep` pulls toward the target. Halo-style two-layer; honors the deadzone like Track.
4. **Sticky** — *active follow*. `stickyStep(targetAngle, aim, stickyFollowFor(strength), blend)` returns
   `base + offset*(1 - follow*blend)` (`offset = aim - base`): your aim is partly glued to the target so
   it auto-follows the enemy's movement while you still steer (compressed offset). Strongest non-snap aid.
5. **Lock** — *hard snap* (`lockPull = 1.0`, eased in by the dwell `blend` so even Lock can be delayed;
   delay 0 = instant legacy snap).

**Knobs (all live-tunable, no rebuild):** Strength (intensity — pull for Track/Hybrid, slow for Friction,
glue for Sticky), Range (engagement cone `coneMinDeg..coneMaxDeg`), Engage Delay (dwell `0..dwellMaxMs`),
Max Distance (`distMinPx..distMaxPx`), Deadzone (`0..deadzoneMaxDeg`, Track/Hybrid), and a **Lead Targets**
checkbox (velocity prediction via `leadAngle(...)`, applied to all aiming modes — velocity from `e.coll.vel`).

Shared acquisition (`selectTarget(tx,ty,aim,coneRad,rangePx,prevIdx,centers,count)`): nearest **enemy**
by aim *angle* within the Range cone, a distance tiebreak within `selectEpsDeg` (fixes "locks the wrong
enemy"), a `releaseFactor` (1.6×) release cone for sticky hysteresis, and the `rangePx` (Max Distance)
cutoff. Off mode disables; Strength 0% makes the pull/slow/glue modes no-ops (Lock still snaps).

Defaults reproduce the validated Track feel: Range 0.4 (~14.4°), Delay 0.5 (~160 ms), Distance 0.5
(600 px), Deadzone 0.4 (~1.6°), Strength 0.5, Lead off. The mode list is **capped at 6** — the menu
button row is 256px wide and splits `floor(256/N)`, so 7+ buttons clip their labels (see below). A
post-fire bullet-magnetism mode was considered and **declined**: it would have to bend the thrown ball,
which also carries CrossCode's *puzzle* throws — too risky to the non-combat game.

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

## How the assist is implemented

Inject `sc.PlayerCrossHairController.updatePos`. After `this.parent(crosshair)` (so the game has
already positioned the crosshair from the stick), `applyAssist`:

1. Gate: mode ≠ Off, `controller.gamepadMode`, `crosshair.active`, strength > 0 (→ `modeConeRad` > 0).
2. Find the alive **enemy** whose **angle** from the thrower is nearest the current aim, within the
   mode's cone (closer enemy wins a near-tie; a `releaseFactor` release cone gives the held target
   sticky hysteresis). Track dwell per acquired enemy.
3. Compute the new aim angle per mode — Track: `trackStep` (capped fractional pull × dwell blend, with
   a center deadzone); Friction: `frictionStep` (damp the stick's per-frame motion); Lock: full snap
   (`nudgeAngle(..., 1)`). Then rotate `coll.pos` to that angle while **preserving `|offset|`** (throw
   range/speed unchanged — only the angle changes).
4. **Neutralize the spread penalty:** set `crosshair._lastDir` to the new offset, so step (2) of
   `deferredUpdate` sees `b ≈ 0` and never grows `rangeCurrent` from the assist. The normal per-frame
   decay still runs, so the spread still tightens to a line — now better aimed. (Skipped when the
   assist makes no effective change, e.g. Track's deadzone or a still-ramping dwell.)

Why this satisfies "don't affect the spread": the only thing the assist changes is the aim *angle*; it
never feeds the spread-growth path, and it preserves the offset magnitude the throw uses. Tunables live
in `CFG` at the top of `prestart.js` (see "Modes & tuning" above).

## Assists-menu integration

- Register seven entries in `sc.OPTIONS_DEFINITION` at `prestart` (so the option model picks up their
  `init` defaults and persists them), all `cat: sc.OPTION_CATEGORY.ASSISTS`:
  - `aim-assist-mode` — `BUTTON_GROUP`, `data: AIM_MODE` (`{OFF:0, FRICTION:2, TRACK:1, HYBRID:3,
    STICKY:4, LOCK:5}`), `init: AIM_MODE.TRACK`, `header: "aimAssist"`, `hasDivider: true` (the header
    text creates the "Aim Assist" section). `sc.options.get` returns the **value** (0–5). The label array
    is indexed by VALUE; the on-screen button ORDER follows AIM_MODE **key-insertion order** (engine does
    `for (k in data) push(data[k])`), so values stay stable (TRACK===1) while display reads subtle→strong.
    **Cap at 6 options** — the button group splits the 256px control area (`g = floor(256/N)`); 7+ clip.
  - `aim-assist-strength` / `-range` / `-delay` / `-distance` / `-deadzone` — `ARRAY_SLIDER`,
    `data: [0, 1]`, `fill: true`, inits `0.5 / 0.4 / 0.5 / 0.5 / 0.4`. Each 0–1 value is mapped to a real
    range by a `*For()` helper in `prestart.js`.
  - `aim-assist-lead` — `CHECKBOX`, `init: false`.
- **Labels:** inject `ig.Lang.get` to return our strings for `sc.gui.options.headers.aimAssist`,
  `sc.gui.options.aim-assist-mode.{name,description}`, and `...aim-assist-mode.group` (an **array** in
  value order `["Off","Track","Friction","Hybrid","Sticky","Lock"]` — the engine does
  `ig.lang.get("sc.gui.options."+name+".group")[value]`), plus `.name`/`.description` for every slider
  and the checkbox, delegating every other key to `this.parent`.
- **Read live:** `sc.options.get("aim-assist-mode")` (0–5), the five sliders (0–1), and
  `get("aim-assist-lead")` (bool).

The shapes mirror the game's own assists options (`assist-damage`, `assist-puzzle-speed`, …), and the
option model builds menu rows by iterating `OPTIONS_DEFINITION` filtered by `cat` — so our entries
render as a normal section.

## Verifying (headless Node — preferred) + optional WKWebView harness

**Primary, fully headless (no game, no browser, no window):** `applyAssist` and all pure helpers are
exported on `window.ccAimAssist`, so two Node suites cover everything `npm test` runs both:

```bash
node test/aim-math.test.js   # pure math + every slider->tunable mapping (vm + stubbed window/sc/ig)
node test/aim-sim.test.js    # loads prestart.js in a vm, stubs sc/ig, drives the REAL applyAssist
                             # frame-by-frame for every mode: dispatch, selection, dwell, deadzone,
                             # Lead, range/distance gating, enemy-only, _lastDir spread-neutralization
```

`aim-sim.test.js` models two frame feeds: **hold/sweep** (reset `coll.pos` to the commanded angle each
frame, then call `applyAssist`) for Friction/Sticky/Lock/Lead, and **accumulate** (let the assist output
persist) to show Track/Hybrid converge and settle. **Gotcha:** in a synthetic sim the aim only moves via
the assist, so place the test enemy/offset *inside* the engagement cone (or widen Range) — otherwise
Track/Hybrid/Sticky correctly refuse to engage (the player must aim roughly at the enemy first).

**Optional in-engine smoke test (boots a WKWebView — opens a window; don't run on a machine where that's
unwanted):** from a cc-ios checkout with assets synced + this mod installed:

```bash
swift build
./.build/debug/webkit-harness --root app/Resources/game --entry ccloader/index.html \
  --prefer-m4a --mods-overlay /tmp/cc-overlay --timeout 120 \
  --eval '(function(){var k=["mode","strength","range","delay","distance","deadzone","lead"];
     return JSON.stringify({
       opts: k.map(function(s){return sc.OPTIONS_DEFINITION["aim-assist-"+s]!=null?1:0;}).join(""),
       group: ig.lang.get("sc.gui.options.aim-assist-mode.group"),
       ctrl: typeof sc.PlayerCrossHairController.prototype.updatePos
   });})()'
```

Notes:
- `--eval` runs at the **title screen** (`ig.game.playerEntity` is null there). Build synthetic tests
  with `new sc.PlayerCrossHairController()` + a stub crosshair + fake `ig.game.entities` — same as
  `aim-sim.test.js`, just in-engine.
- Success line: `bootstrap=true platform=Browser jsErrors=0`.
- Headless caveat: the title→options menu *visual* transition doesn't always paint in the harness, so
  verify the menu by data (`OPTIONS_DEFINITION` + `ig.lang.get`) rather than a screenshot.

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
