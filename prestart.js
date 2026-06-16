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

	var OPT_MODE = "aim-assist-mode";
	var OPT_STRENGTH = "aim-assist-strength";
	var OPT_RANGE = "aim-assist-range";
	var OPT_DELAY = "aim-assist-delay";
	var OPT_DISTANCE = "aim-assist-distance";
	var OPT_DEADZONE = "aim-assist-deadzone";
	var OPT_LEAD = "aim-assist-lead";

	// Behavior modes. The VALUE is what `sc.options.get` returns and what persists; the LABEL array
	// (LANG ".group") is indexed by value. KEY-INSERTION order controls the on-screen button order
	// (the engine does `for (k in data) push(data[k])`), so we can display subtle->strong while keeping
	// TRACK === 1 stable across versions. NOTE: keep this to <= 6 entries — the button group splits the
	// 256px control area evenly (floor(256/N)), so 7+ buttons clip their text.
	var AIM_MODE = { OFF: 0, FRICTION: 2, TRACK: 1, HYBRID: 3, STICKY: 4, LOCK: 5 };

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

	// ---- Localization for our Assists-menu entries ------------------------------------
	// ig.lang.get(path) walks ig.lang.labels; we intercept only our keys and delegate the rest.
	// The BUTTON_GROUP reads "...mode.group" as an ARRAY and indexes it by the AIM_MODE VALUE
	// (0..5), so this array is in value order, not display order.
	var LANG = {
		"sc.gui.options.headers.aimAssist": "Aim Assist",
		"sc.gui.options.aim-assist-mode.name": "Aim Assist",
		"sc.gui.options.aim-assist-mode.description":
			"Pick ONE way aiming with a controller helps you hit ENEMIES (only enemies, never objects). " +
			"Friction slows your aim near an enemy. Track gently follows an enemy you're aiming at " +
			"(engages after a brief moment, never snaps). Hybrid does both. Sticky glues your aim to the " +
			"target so it follows their movement. Lock snaps onto the nearest enemy. Bullet spread is " +
			"never affected.",
		"sc.gui.options.aim-assist-mode.group": ["Off", "Track", "Friction", "Hybrid", "Sticky", "Lock"],
		"sc.gui.options.aim-assist-strength.name": "Strength",
		"sc.gui.options.aim-assist-strength.description":
			"How hard Track/Hybrid pull, how much Friction slows, or how glued Sticky is. (Lock always " +
			"snaps.) 0% = no help for the pull/slow/glue modes.",
		"sc.gui.options.aim-assist-range.name": "Range",
		"sc.gui.options.aim-assist-range.description":
			"The engagement cone — how close to an enemy you must aim before any assist kicks in. " +
			"Lower is tighter (only when you're nearly pointing at them); higher helps from a wider angle.",
		"sc.gui.options.aim-assist-delay.name": "Engage Delay",
		"sc.gui.options.aim-assist-delay.description":
			"How long you must hold aim near an enemy before the assist engages. 0% = instant; higher " +
			"makes it wait, so sweeping the stick past enemies won't grab them.",
		"sc.gui.options.aim-assist-distance.name": "Max Distance",
		"sc.gui.options.aim-assist-distance.description":
			"How far away an enemy can be and still be assisted. Lower ignores distant enemies.",
		"sc.gui.options.aim-assist-deadzone.name": "Deadzone",
		"sc.gui.options.aim-assist-deadzone.description":
			"When you're already this close to dead-on the enemy, Track/Hybrid back off so they don't " +
			"fight your fine aiming. Higher = larger hands-off zone.",
		"sc.gui.options.aim-assist-lead.name": "Lead Targets",
		"sc.gui.options.aim-assist-lead.description":
			"Aim where a moving enemy is heading instead of where they are now (helps Track, Hybrid, " +
			"Sticky and Lock hit enemies that strafe). Off aims at their current position."
	};

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
		if (typeof sc === "undefined" || !sc.options) return;
		var mode = sc.options.get(OPT_MODE);
		if (!mode) return;                                   // Off (0)
		if (!controller.gamepadMode) return;                 // analog-stick aiming only
		if (!crosshair || !crosshair.active || !crosshair.coll) return; // only while actively aiming
		if (!sc.COMBATANT_PARTY) return;

		var strength = clamp01(sc.options.get(OPT_STRENGTH));
		var coneRad = coneRadFor(sc.options.get(OPT_RANGE));
		var rangePx = distPxFor(sc.options.get(OPT_DISTANCE));
		var dwellFrames = dwellFramesFor(sc.options.get(OPT_DELAY));
		var deadzoneRad = deadzoneRadFor(sc.options.get(OPT_DEADZONE));
		var lead = !!sc.options.get(OPT_LEAD);

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

		// 1) Register the options so they appear in the Assists menu. Added at prestart so the option
		//    model picks up the `init` defaults (and persists them) when it initializes during boot.
		//    Defaults reproduce the validated Track feel: cone ~14.4°, dwell ~160ms, 600px, deadzone 1.6°.
		if (sc.OPTIONS_DEFINITION && sc.OPTION_CATEGORY) {
			var A = sc.OPTION_CATEGORY.ASSISTS;
			sc.OPTIONS_DEFINITION[OPT_MODE] = {
				type: "BUTTON_GROUP", data: AIM_MODE, init: AIM_MODE.TRACK,
				cat: A, hasDivider: true, header: "aimAssist"
			};
			sc.OPTIONS_DEFINITION[OPT_STRENGTH] = { type: "ARRAY_SLIDER", data: [0, 1], init: 0.5, cat: A, fill: true };
			sc.OPTIONS_DEFINITION[OPT_RANGE] = { type: "ARRAY_SLIDER", data: [0, 1], init: 0.4, cat: A, fill: true };
			sc.OPTIONS_DEFINITION[OPT_DELAY] = { type: "ARRAY_SLIDER", data: [0, 1], init: 0.5, cat: A, fill: true };
			sc.OPTIONS_DEFINITION[OPT_DISTANCE] = { type: "ARRAY_SLIDER", data: [0, 1], init: 0.5, cat: A, fill: true };
			sc.OPTIONS_DEFINITION[OPT_DEADZONE] = { type: "ARRAY_SLIDER", data: [0, 1], init: 0.4, cat: A, fill: true };
			sc.OPTIONS_DEFINITION[OPT_LEAD] = { type: "CHECKBOX", init: false, cat: A };
		} else {
			console.warn("[cc-aimassist] OPTIONS_DEFINITION/OPTION_CATEGORY missing; menu entries skipped");
		}

		// 2) Provide labels for our entries (delegate every other key to the game).
		if (ig.Lang) {
			ig.Lang.inject({
				get: function (key) {
					var v = LANG[key];
					return v != null ? v : this.parent(key);
				}
			});
		}

		// 3) Hook the gamepad aim update.
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
		// headlessly in Node with stubbed sc/ig — no WKWebView needed.
		window.ccAimAssist = {
			CFG: CFG, LANG: LANG, AIM_MODE: AIM_MODE,
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
