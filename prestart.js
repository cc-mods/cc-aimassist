/* cc-aimassist — controller aim assist for CrossCode (desktop + cc-ios).
 *
 * WHAT IT DOES
 *   While you aim with an analog stick, the mod helps you point at a nearby ENEMY. It targets only
 *   alive enemy combatants (never NPCs, props, or destructibles) and it never touches the game's
 *   bullet-spread mechanic: whatever the assist does to your aim angle is hidden from the spread
 *   system, so your shots tighten to a line exactly as before — that line is just better aimed.
 *
 *   ONE behavior is active at a time (a single-select Mode), tuned by a set of live knobs in the
 *   in-game Assists menu (new "Aim Assist" section) — dial in the feel on any device, no rebuild:
 *
 *     Mode (pick one):
 *       Off       disabled.
 *       Friction  slows your stick's angular motion near an enemy so aim is easier to hold/track.
 *                 Never moves your aim for you — the purest, most "invisible" assist.
 *       Track     (default) a gentle, per-frame-capped angular PULL toward the enemy you're already
 *                 pointing at. Doesn't snap: engages only after you've held aim near an enemy for the
 *                 Engage Delay, then eases your aim to follow them. A center Deadzone keeps it from
 *                 fighting fine corrections. A tracking aid, not a lock-on.
 *       Hybrid    Friction + Track together (the canonical two-layer feel): your stick slows near an
 *                 enemy AND your aim is gently pulled toward them. Grippier than Track, still gentle.
 *       Sticky    active follow — once engaged, your aim is partly GLUED to the target so it follows
 *                 their movement automatically; your stick still steers (with a compressed offset).
 *                 The strongest tracking aid short of a hard lock.
 *       Lock      hard snap straight onto the nearest enemy (the original behavior).
 *
 *     Knobs: Strength (how hard Track/Hybrid pull / how much Friction slows / how glued Sticky is),
 *       Range (engagement cone), Engage Delay (dwell before it engages), Max Distance, Deadzone
 *       (Track/Hybrid hands-off zone), and Lead Targets (aim where a moving enemy is heading).
 *
 * HOW IT HOOKS THE GAME  (verified against game.compiled.js v1.4.2 + ultimate-crosscode-typedefs)
 *   Each frame, ig.ENTITY.Crosshair.deferredUpdate():
 *     1. controller.updatePos(crosshair)  -> sets crosshair.coll.pos from the right stick (gamepad)
 *                                            or the mouse.
 *     2. a = coll.pos - throwerPos;  b = angle(a, _lastDir).
 *        if (!special && b > 2*maxAngleMove) -> widen rangeCurrent (the random spread "penalty").
 *     3. _lastDir = a;  _aimDir = a.    getThrowDir()/getDir() return _aimDir (rotated by the spread).
 *   The AIM DIRECTION is normalize(coll.pos - throwerPos); the THROW DISTANCE is |coll.pos - throwerPos|.
 *
 *   We inject sc.PlayerCrossHairController.updatePos. After the game positions the crosshair, if an
 *   enemy is inside the engagement cone we rotate coll.pos toward it WHILE PRESERVING its distance from
 *   the thrower (so throw range/speed is identical to vanilla — only the angle changes). Whenever we
 *   change the angle we also set crosshair._lastDir to the new offset so step (2)'s penalty check sees
 *   zero movement from the assist — the assist can never blow up the spread. rangeCurrent's normal
 *   per-frame decay still runs, so the cone still tightens to a line, now better aimed.
 *
 *   This relies only on core engine classes (no NW.js/desktop- or cc-ios-specific APIs), so the same
 *   prestart mod works on desktop CrossCode and inside the cc-ios WebKit wrapper. Everything is wrapped
 *   in try/catch so a mod error can never reach game init (which would show the CRITICAL BUG screen).
 */
(function () {
	"use strict";

	// Mod id + the per-setting keys. Settings live on this mod's CCModManager "Mod settings" page
	// (registered in poststart.js) — NOT the native game menus (suite convention: a mod's settings
	// live on its CCModManager page; see cc-mods/cc-agent-tools › crosscode-modding.md). CCModManager
	// persists each setting to localStorage under "<modId>-<key>" (e.g. "cc-aimassist-mode"), which we
	// read live below. No CCModManager (e.g. desktop without it) → keys are absent → we use DEFAULTS,
	// so the mod still works (no settings UI). The keys here MUST match poststart.js's option keys.
	var MOD_ID = "cc-aimassist";
	var K_MODE = "mode";
	var K_STRENGTH = "strength";
	var K_RANGE = "range";
	var K_DELAY = "delay";
	var K_DISTANCE = "distance";
	var K_DEADZONE = "deadzone";
	var K_LEAD = "lead";

	// Behavior modes. The VALUE is what persists (CCModManager BUTTON_GROUP stores the enum value) and
	// what the per-frame logic switches on; poststart.js's value-indexed `buttonNames` supplies labels.
	// KEY-INSERTION order controls the on-screen button order (the button group does `for (k in data)`),
	// so we display subtle->strong while keeping TRACK === 1 stable across versions. NOTE: keep this to
	// <= 6 entries — the button group splits the control area evenly, so 7+ buttons clip their text.
	var AIM_MODE = { OFF: 0, FRICTION: 2, TRACK: 1, HYBRID: 3, STICKY: 4, LOCK: 5 };

	// Default for each setting, used until the user changes it (and whenever CCModManager isn't present
	// to host/seed the settings). These reproduce the validated Track feel; poststart.js's `init` values
	// MUST match these so the menu and the fallback agree.
	var DEFAULTS = {
		mode: AIM_MODE.TRACK, strength: 0.5, range: 0.4, delay: 0.5, distance: 0.5, deadzone: 0.4, lead: false
	};

	// Live setting reads from localStorage ("<modId>-<key>"), with a default when absent/invalid. Read
	// per frame (like the old sc.options.get path) so menu changes apply immediately, no restart.
	function lsGet(key) {
		try { return window.localStorage ? window.localStorage.getItem(MOD_ID + "-" + key) : null; }
		catch (e) { return null; }
	}
	function optNum(key, def) {
		var v = lsGet(key);
		if (v == null || v === "") return def;
		var n = Number(v);
		return isFinite(n) ? n : def;
	}
	function optBool(key, def) {
		var v = lsGet(key);
		return v == null ? def : v === "true";
	}


	// ---- Tuning ------------------------------------------------------------------------
	// The menu exposes the knobs below; these constants set the range each 0..1 slider maps onto.
	var DEG = Math.PI / 180;
	var CFG = {
		// target acquisition
		releaseFactor: 1.6,       // hysteresis: hold the current target until aim exceeds cone*this
		selectEpsDeg: 3,          // within this angular tie, prefer the CLOSER enemy (anti "wrong enemy")
		coneMinDeg: 4, coneMaxDeg: 30,     // Range slider 0..1 -> engagement half-angle (deg)
		distMinPx: 200, distMaxPx: 1000,   // Max Distance slider 0..1 -> world-px cutoff
		dwellMaxMs: 320, frameMs: 1000 / 60, // Engage Delay slider 0..1 -> dwell ms (then frames)
		dwellDecay: 2,            // dwell frames shed per frame when not within the engagement cone
		deadzoneMaxDeg: 4,        // Deadzone slider 0..1 -> half-angle Track/Hybrid back off within (deg)

		// intensity (Strength slider 0..1)
		trackPullMax: 0.18,       // Track/Hybrid: fraction of remaining angular error eased per frame at full strength
		trackCapMinDeg: 0.6, trackCapMaxDeg: 3.0, // Track/Hybrid: per-frame rotation cap (deg/frame), lerped by strength
		frictionMax: 0.6,         // Friction: fraction of the stick's per-frame angular motion removed
		hybridFrictionScale: 0.75, // Hybrid slows a bit less than pure Friction (it also pulls)
		stickyFollowMax: 0.85,    // Sticky: max fraction of your off-target offset compressed toward the target
		lockPull: 1.0,            // Lock: hard snap

		// Lead Targets (velocity prediction)
		leadSec: 0.30             // aim where the enemy will be this many seconds ahead
	};

	// ---- Pure math (game-agnostic, harness-testable) ----------------------------------
	var TAU = Math.PI * 2;
	function norm(a) { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; }
	function angleDelta(a, b) { return norm(b - a); }                  // shortest signed a -> b (rad)
	function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
	function clamp01(v) { return typeof v !== "number" ? 0 : clamp(v, 0, 1); }
	function lerp(a, b, t) { return a + (b - a) * t; }
	function nudgeAngle(aim, target, pull) { return norm(aim + angleDelta(aim, target) * pull); }

	// Slider (0..1) -> concrete tunables. Pure; exported for unit tests.
	function coneRadFor(rangeOpt) { return lerp(CFG.coneMinDeg, CFG.coneMaxDeg, clamp01(rangeOpt)) * DEG; }
	function distPxFor(distOpt) { return lerp(CFG.distMinPx, CFG.distMaxPx, clamp01(distOpt)); }
	function dwellFramesFor(delayOpt) { return Math.round(clamp01(delayOpt) * CFG.dwellMaxMs / CFG.frameMs); }
	function deadzoneRadFor(dzOpt) { return clamp01(dzOpt) * CFG.deadzoneMaxDeg * DEG; }
	function pullFor(strength) { return clamp01(strength) * CFG.trackPullMax; }
	function capRadFor(strength) { return lerp(CFG.trackCapMinDeg, CFG.trackCapMaxDeg, clamp01(strength)) * DEG; }
	function frictionFor(strength) { return clamp01(strength) * CFG.frictionMax; }
	function stickyFollowFor(strength) { return clamp01(strength) * CFG.stickyFollowMax; }

	// Track/Hybrid: ease `aim` toward `target` by `pull` (fraction) and a `blend` (dwell ramp 0..1), but
	// never rotate more than `capRad` in a single frame. Returns the new absolute aim angle (rad).
	function trackStep(aim, target, pull, capRad, blend) {
		var err = angleDelta(aim, target);
		var step = clamp(err * pull * blend, -capRad, capRad);
		return norm(aim + step);
	}

	// Friction: keep only `1 - f` of the angular movement the stick made this frame (prev -> aim).
	// f in 0..1. Returns the damped absolute aim angle (rad). f=0 -> no change; f=1 -> aim frozen.
	function frictionStep(prevAim, aim, f) {
		return norm(prevAim + angleDelta(prevAim, aim) * (1 - clamp01(f)));
	}

	// Sticky: partly glue aim to the target. `base` is the target angle; your `aim` becomes a compressed
	// offset from it (so the reticle follows the target automatically as `base` moves with the enemy,
	// while you can still steer). follow*blend in 0..1: 0 -> returns aim unchanged; 1 -> returns base.
	function stickyStep(base, aim, follow, blend) {
		var offset = angleDelta(base, aim);
		return norm(base + offset * (1 - clamp01(follow) * clamp01(blend)));
	}

	// Lead: angle from thrower (tx,ty) to where an enemy at (cx,cy) moving (vx,vy) px/s will be in
	// `leadSec` seconds. Returns radians. Pure; exported for unit tests.
	function leadAngle(cx, cy, vx, vy, leadSec, tx, ty) {
		return Math.atan2((cy + vy * leadSec) - ty, (cx + vx * leadSec) - tx);
	}

	// Choose the best enemy within reach. `centers` is an array of {x,y} (only the first `count`
	// entries are considered; defaults to centers.length); `prevIdx` is last frame's locked target
	// (or -1). A NEW target must be inside `coneRad`; the HELD target is kept while it stays inside the
	// wider release cone (coneRad*releaseFactor) so the lock doesn't flicker. Among near-equal angles
	// the CLOSER enemy wins. Returns { idx, angle } or null. Pure — used live and by the self-test.
	function selectTarget(tx, ty, aimAngle, coneRad, rangePx, prevIdx, centers, count) {
		if (count == null) count = centers ? centers.length : 0;
		if (coneRad <= 0 || !centers || count <= 0) return null;
		var release = coneRad * CFG.releaseFactor;
		var eps = CFG.selectEpsDeg * DEG;
		var maxD2 = rangePx * rangePx;
		var bestIdx = -1, bestErr = Infinity, bestAngle = 0, bestDist = Infinity;
		var prevErr = Infinity, prevAngle = 0;
		for (var i = 0; i < count; i++) {
			var c = centers[i];
			if (!c) continue;
			var dx = c.x - tx, dy = c.y - ty;
			var d2 = dx * dx + dy * dy;
			if (d2 < 1 || d2 > maxD2) continue;
			var ang = Math.atan2(dy, dx);
			var err = Math.abs(angleDelta(aimAngle, ang));
			if (i === prevIdx && err < prevErr) { prevErr = err; prevAngle = ang; }
			if (err >= coneRad) continue;                          // outside the acquisition cone
			// Primary: smallest angular error. Tie (within eps): the closer enemy — fixes "wrong enemy".
			if (err < bestErr - eps || (err < bestErr + eps && d2 < bestDist)) {
				bestErr = err; bestIdx = i; bestAngle = ang; bestDist = d2;
			}
		}
		// Sticky lock: keep the previous target while it stays inside the release cone.
		if (prevIdx >= 0 && prevErr <= release) return { idx: prevIdx, angle: prevAngle };
		if (bestIdx >= 0) return { idx: bestIdx, angle: bestAngle };
		return null;
	}

	// (User-facing labels + descriptions for these settings now live in poststart.js, which registers
	// them on the CCModManager "Mod settings" page. The per-frame logic below is label-agnostic.)

	// ---- Live enemy targeting (scans ig.game.entities for alive enemy combatants) ------
	// Pooled across frames to stay allocation-free: parallel arrays hold reusable {x,y} centers, the
	// entity refs (so hysteresis/dwell track a specific enemy across frames as list order changes), and
	// each enemy's velocity (for Lead). `_enemyCount` is how many leading slots are valid this frame;
	// the pool only grows, never shrinks.
	var _centers = [];
	var _refs = [];
	var _vx = [];
	var _vy = [];
	var _enemyCount = 0;
	var _scratch = { x: 0, y: 0 };

	function collectEnemies(party) {
		_enemyCount = 0;
		var ents = ig.game && ig.game.entities;
		if (!ents) return;
		for (var i = 0; i < ents.length; i++) {
			var e = ents[i];
			if (!e || e.isCombatant !== true || e.party !== party) continue;   // alive ENEMY combatants only
			if (e.isDefeated && e.isDefeated()) continue;
			if (!e.getCenter) continue;
			var c = e.getCenter(_scratch);
			if (!c) continue;
			var slot = _centers[_enemyCount];
			if (!slot) { slot = { x: 0, y: 0 }; _centers[_enemyCount] = slot; } // grow pool once
			slot.x = c.x; slot.y = c.y;
			_refs[_enemyCount] = e;
			var vel = e.coll && e.coll.vel;
			_vx[_enemyCount] = vel ? (vel.x || 0) : 0;
			_vy[_enemyCount] = vel ? (vel.y || 0) : 0;
			_enemyCount++;
		}
	}

	function applyAssist(controller, crosshair) {
		if (typeof sc === "undefined") return;
		var mode = optNum(K_MODE, DEFAULTS.mode);
		if (!mode) return;                                   // Off (0)
		if (!controller.gamepadMode) return;                 // analog-stick aiming only
		if (!crosshair || !crosshair.active || !crosshair.coll) return; // only while actively aiming
		if (!sc.COMBATANT_PARTY) return;

		var strength = clamp01(optNum(K_STRENGTH, DEFAULTS.strength));
		var coneRad = coneRadFor(optNum(K_RANGE, DEFAULTS.range));
		var rangePx = distPxFor(optNum(K_DISTANCE, DEFAULTS.distance));
		var dwellFrames = dwellFramesFor(optNum(K_DELAY, DEFAULTS.delay));
		var deadzoneRad = deadzoneRadFor(optNum(K_DEADZONE, DEFAULTS.deadzone));
		var lead = optBool(K_LEAD, DEFAULTS.lead);

		var tp = crosshair._getThrowerPos(_scratch);
		var tx = tp.x, ty = tp.y;
		var ox = crosshair.coll.pos.x - tx, oy = crosshair.coll.pos.y - ty;
		var dist = Math.sqrt(ox * ox + oy * oy);
		if (dist < 1) return;
		var aimAngle = Math.atan2(oy, ox);

		collectEnemies(sc.COMBATANT_PARTY.ENEMY);

		// Resolve last frame's target entity to its current index (identity-stable hysteresis/dwell).
		var prevIdx = -1;
		if (controller._ccTargetRef) {
			for (var j = 0; j < _enemyCount; j++) {
				if (_refs[j] === controller._ccTargetRef) { prevIdx = j; break; }
			}
		}

		var pick = selectTarget(tx, ty, aimAngle, coneRad, rangePx, prevIdx, _centers, _enemyCount);
		if (!pick) {                                         // nothing in reach: fade out, remember aim
			controller._ccTargetRef = null;
			controller._ccDwell = 0;
			controller._ccPrevAim = aimAngle;
			return;
		}

		// Dwell: each newly ACQUIRED enemy starts its own timer (so sweeping the stick through a crowd
		// never grabs intermediate enemies). The timer fills only while aim is inside the cone.
		var newRef = _refs[pick.idx];
		if (newRef !== controller._ccTargetRef) controller._ccDwell = 0;
		controller._ccTargetRef = newRef;

		var absErr = Math.abs(angleDelta(aimAngle, pick.angle));
		if (absErr <= coneRad) controller._ccDwell = Math.min((controller._ccDwell || 0) + 1, dwellFrames);
		else controller._ccDwell = Math.max(0, (controller._ccDwell || 0) - CFG.dwellDecay);
		var blend = dwellFrames > 0 ? Math.min(controller._ccDwell, dwellFrames) / dwellFrames : 1;

		// Where to aim: the enemy's current angle, or its predicted angle when Lead is on.
		var targetAngle = pick.angle;
		if (lead && mode !== AIM_MODE.FRICTION) {
			var i2 = pick.idx;
			var px = _centers[i2].x + _vx[i2] * CFG.leadSec;
			var py = _centers[i2].y + _vy[i2] * CFG.leadSec;
			if ((px - tx) * (px - tx) + (py - ty) * (py - ty) > 1) targetAngle = Math.atan2(py - ty, px - tx);
		}

		var prev = (typeof controller._ccPrevAim === "number") ? controller._ccPrevAim : aimAngle;
		var na = aimAngle;
		if (mode === AIM_MODE.FRICTION) {
			na = frictionStep(prev, aimAngle, frictionFor(strength) * blend);
		} else if (mode === AIM_MODE.HYBRID) {
			if (Math.abs(angleDelta(aimAngle, targetAngle)) <= deadzoneRad) { controller._ccPrevAim = aimAngle; return; }
			var fr = frictionStep(prev, aimAngle, frictionFor(strength) * CFG.hybridFrictionScale * blend);
			na = trackStep(fr, targetAngle, pullFor(strength), capRadFor(strength), blend);
		} else if (mode === AIM_MODE.STICKY) {
			na = stickyStep(targetAngle, aimAngle, stickyFollowFor(strength), blend);
		} else if (mode === AIM_MODE.LOCK) {
			na = nudgeAngle(aimAngle, targetAngle, CFG.lockPull * blend); // blend lets Engage Delay ease the snap in
		} else { // TRACK
			if (Math.abs(angleDelta(aimAngle, targetAngle)) <= deadzoneRad) { // dead-on: hands off, no spread masking
				controller._ccPrevAim = aimAngle;
				return;
			}
			na = trackStep(aimAngle, targetAngle, pullFor(strength), capRadFor(strength), blend);
		}

		controller._ccPrevAim = na;
		if (Math.abs(angleDelta(aimAngle, na)) < 1e-4) return; // no effective change (e.g. dwell ramping)

		var nx = Math.cos(na) * dist, ny = Math.sin(na) * dist;  // preserve distance => throw range
		crosshair.coll.pos.x = tx + nx;
		crosshair.coll.pos.y = ty + ny;

		// Keep the assist out of the spread system: make this frame's aim-direction change look like
		// "no movement" to deferredUpdate's precision-penalty check (b = angle(newOffset, _lastDir)).
		// rangeCurrent's normal decay still runs, so the cone still tightens to a line on the enemy.
		if (crosshair._lastDir) { crosshair._lastDir.x = nx; crosshair._lastDir.y = ny; }
	}

	// ---- Wire-up (prestart: sc.* is defined; addons/options init later during boot) -----
	try {
		if (typeof sc === "undefined") {
			console.warn("[cc-aimassist] sc.* unavailable; skipping (wrong load stage?)");
			return;
		}

		// Idempotency: some loaders read both ccmod.json and package.json and run prestart twice.
		if (window.__ccAimAssistInit) { return; }
		window.__ccAimAssistInit = true;

		// Settings (mode + tuning knobs) are registered on the CCModManager "Mod settings" page by
		// poststart.js and read live from localStorage above — nothing to register in the native menus.

		// Hook the gamepad aim update.
		if (sc.PlayerCrossHairController) {
			sc.PlayerCrossHairController.inject({
				updatePos: function (crosshair) {
					this.parent(crosshair);
					try { applyAssist(this, crosshair); }
					catch (e) { console.error("[cc-aimassist] non-fatal:", e); }
				}
			});
		} else {
			console.warn("[cc-aimassist] sc.PlayerCrossHairController missing; aim hook skipped");
		}

		// Debug / live-tuning / harness self-test surface. `applyAssist` is exported so the per-frame
		// integration (mode dispatch, dwell, deadzone, lead, spread-neutralization) can be driven
		// headlessly in Node with stubbed sc/ig — no WKWebView needed. MOD_ID/keys/DEFAULTS are shared
		// with poststart.js (the single source of truth for the settings contract).
		window.ccAimAssist = {
			CFG: CFG, AIM_MODE: AIM_MODE, DEFAULTS: DEFAULTS,
			MOD_ID: MOD_ID,
			KEYS: { mode: K_MODE, strength: K_STRENGTH, range: K_RANGE, delay: K_DELAY, distance: K_DISTANCE, deadzone: K_DEADZONE, lead: K_LEAD },
			optNum: optNum, optBool: optBool,
			angleDelta: angleDelta, nudgeAngle: nudgeAngle, trackStep: trackStep, frictionStep: frictionStep,
			stickyStep: stickyStep, leadAngle: leadAngle, selectTarget: selectTarget, applyAssist: applyAssist,
			coneRadFor: coneRadFor, distPxFor: distPxFor, dwellFramesFor: dwellFramesFor,
			deadzoneRadFor: deadzoneRadFor, pullFor: pullFor, capRadFor: capRadFor,
			frictionFor: frictionFor, stickyFollowFor: stickyFollowFor
		};

		console.log("[cc-aimassist] loaded (modes Off/Friction/Track/Hybrid/Sticky/Lock + Strength/Range/Delay/Distance/Deadzone/Lead)");
	} catch (e) {
		console.error("[cc-aimassist] init failed (non-fatal):", e);
	}
})();
