/* cc-aim-assist — controller aim assist for CrossCode (desktop + cc-ios).
 *
 * WHAT IT DOES
 *   When you aim with an analog stick and point CLOSE ENOUGH to an enemy, the center of your throw
 *   aim locks onto that enemy. It's a thresholded snap (a lock), not a slow drag, and it deliberately
 *   leaves the game's bullet-spread mechanic untouched: your shots still tighten to a line exactly as
 *   before — that line is just re-centered on the enemy.
 *
 *   Two settings live in the in-game Assists menu (new "Aim Assist" section):
 *     - a checkbox to enable/disable it, and
 *     - a "Lock Range" slider controlling how close you must aim for the lock to engage (the cone).
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
 *   enemy is inside the lock cone we rotate coll.pos to point exactly at it WHILE PRESERVING its
 *   distance from the thrower (so throw range/speed is identical to vanilla — only the angle changes).
 *   We then set crosshair._lastDir to the snapped offset so step (2)'s penalty check sees zero movement
 *   from our snap — the snap can never blow up the spread. rangeCurrent's normal per-frame decay still
 *   runs, so the cone still tightens to a line, now centered on the enemy.
 *
 *   This relies only on core engine classes (no NW.js/desktop- or cc-ios-specific APIs), so the same
 *   prestart mod works on desktop CrossCode and inside the cc-ios WebKit wrapper. Everything is wrapped
 *   in try/catch so a mod error can never reach game init (which would show the CRITICAL BUG screen).
 */
(function () {
	"use strict";

	var OPT_ENABLED = "aim-assist-enabled";
	var OPT_STRENGTH = "aim-assist-strength";

	// ---- Tuning (the menu exposes enable + cone; these shape the rest) -----------------
	var CFG = {
		maxConeDeg: 35,      // slider value 1.0 maps to this lock-cone half-angle (degrees)
		rangePx: 700,        // ignore enemies farther than this from the thrower (world px)
		releaseFactor: 1.5,  // hysteresis: hold the current target until aim exceeds cone*this
		pull: 1.0            // 1 = hard snap (lock); < 1 would be a partial pull toward the target
	};

	// ---- Pure math (game-agnostic, harness-testable) ----------------------------------
	var TAU = Math.PI * 2;
	function norm(a) { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; }
	function angleDelta(a, b) { return norm(b - a); }                  // shortest signed a -> b (rad)
	function nudgeAngle(aim, target, pull) { return norm(aim + angleDelta(aim, target) * pull); }
	function coneRadFor(strength) {
		if (typeof strength !== "number" || strength < 0) strength = 0;
		else if (strength > 1) strength = 1;
		return strength * CFG.maxConeDeg * Math.PI / 180;
	}

	// Choose the best enemy angle within the cone. `centers` is an array of {x,y} (only the first
	// `count` entries are considered; defaults to centers.length); `prevIdx` is the index of last
	// frame's locked target (or -1). Honors a wider "release" cone for the held target so the lock
	// doesn't flicker at the boundary or between two near-equidistant enemies.
	// Returns { idx, angle } or null. Pure — used live and by the harness self-test.
	function selectTarget(tx, ty, aimAngle, coneRad, prevIdx, centers, count) {
		if (count == null) count = centers ? centers.length : 0;
		if (coneRad <= 0 || !centers || count <= 0) return null;
		var release = coneRad * CFG.releaseFactor;
		var bestIdx = -1, bestErr = coneRad, bestAngle = 0;
		var prevErr = Infinity, prevAngle = 0;
		for (var i = 0; i < count; i++) {
			var c = centers[i];
			if (!c) continue;
			var dx = c.x - tx, dy = c.y - ty;
			var d2 = dx * dx + dy * dy;
			if (d2 < 1 || d2 > CFG.rangePx * CFG.rangePx) continue;
			var ang = Math.atan2(dy, dx);
			var err = Math.abs(angleDelta(aimAngle, ang));
			if (i === prevIdx && err < prevErr) { prevErr = err; prevAngle = ang; }
			if (err < bestErr) { bestErr = err; bestIdx = i; bestAngle = ang; }
		}
		// Sticky lock: keep the previous target while it stays inside the release cone.
		if (prevIdx >= 0 && prevErr <= release) return { idx: prevIdx, angle: prevAngle };
		if (bestIdx >= 0) return { idx: bestIdx, angle: bestAngle };
		return null;
	}

	// ---- Localization for our Assists-menu entries ------------------------------------
	// ig.lang.get(path) walks ig.lang.labels; we intercept only our keys and delegate the rest.
	var LANG = {
		"sc.gui.options.headers.aimAssist": "Aim Assist",
		"sc.gui.options.aim-assist-enabled.name": "Enable Aim Assist",
		"sc.gui.options.aim-assist-enabled.description":
			"Locks the center of your aim onto a nearby enemy when you aim close to it with a controller. Bullet spread is not affected.",
		"sc.gui.options.aim-assist-strength.name": "Lock Range",
		"sc.gui.options.aim-assist-strength.description":
			"How close to an enemy you must aim for the lock to engage. Higher locks on from a wider angle; 0% turns the lock off."
	};

	// ---- Live enemy targeting (scans ig.game.entities for alive enemy combatants) ------
	// Pooled across frames to stay allocation-free: `_centers` holds reusable {x,y} points and
	// `_refs` the parallel entity refs (so hysteresis can track a specific enemy across frames even
	// as list order changes). `_enemyCount` is how many leading slots are valid this frame; the pool
	// only grows, never shrinks.
	var _centers = [];
	var _refs = [];
	var _enemyCount = 0;
	var _scratch = { x: 0, y: 0 };

	function collectEnemies(party) {
		_enemyCount = 0;
		var ents = ig.game && ig.game.entities;
		if (!ents) return;
		for (var i = 0; i < ents.length; i++) {
			var e = ents[i];
			if (!e || e.isCombatant !== true || e.party !== party) continue;
			if (e.isDefeated && e.isDefeated()) continue;
			if (!e.getCenter) continue;
			var c = e.getCenter(_scratch);
			if (!c) continue;
			var slot = _centers[_enemyCount];
			if (!slot) { slot = { x: 0, y: 0 }; _centers[_enemyCount] = slot; } // grow pool once
			slot.x = c.x; slot.y = c.y;
			_refs[_enemyCount] = e;
			_enemyCount++;
		}
	}

	function applyAssist(controller, crosshair) {
		if (typeof sc === "undefined" || !sc.options || !sc.options.get(OPT_ENABLED)) return;
		if (!controller.gamepadMode) return;                 // analog-stick aiming only
		if (!crosshair || !crosshair.active || !crosshair.coll) return; // only while actively aiming
		if (!sc.COMBATANT_PARTY) return;

		var coneRad = coneRadFor(sc.options.get(OPT_STRENGTH));
		if (coneRad <= 0) return;                            // slider at 0% -> lock off

		var tp = crosshair._getThrowerPos(_scratch);
		var tx = tp.x, ty = tp.y;
		var ox = crosshair.coll.pos.x - tx, oy = crosshair.coll.pos.y - ty;
		var dist = Math.sqrt(ox * ox + oy * oy);
		if (dist < 1) return;
		var aimAngle = Math.atan2(oy, ox);

		collectEnemies(sc.COMBATANT_PARTY.ENEMY);

		// Resolve last frame's target entity to its current index (identity-stable hysteresis).
		var prevIdx = -1;
		if (controller._ccTargetRef) {
			for (var j = 0; j < _enemyCount; j++) {
				if (_refs[j] === controller._ccTargetRef) { prevIdx = j; break; }
			}
		}

		var pick = selectTarget(tx, ty, aimAngle, coneRad, prevIdx, _centers, _enemyCount);
		if (!pick) { controller._ccTargetRef = null; return; }
		controller._ccTargetRef = _refs[pick.idx];

		var na = nudgeAngle(aimAngle, pick.angle, CFG.pull);
		var nx = Math.cos(na) * dist, ny = Math.sin(na) * dist;  // preserve distance => throw range
		crosshair.coll.pos.x = tx + nx;
		crosshair.coll.pos.y = ty + ny;

		// Keep the lock out of the spread system: make this frame's aim-direction change look like
		// "no movement" to deferredUpdate's precision-penalty check (b = angle(newOffset, _lastDir)).
		// rangeCurrent's normal decay still runs, so the cone still tightens to a line on the enemy.
		if (crosshair._lastDir) { crosshair._lastDir.x = nx; crosshair._lastDir.y = ny; }
	}

	// ---- Wire-up (prestart: sc.* is defined; addons/options init later during boot) -----
	try {
		if (typeof sc === "undefined") {
			console.warn("[cc-aim-assist] sc.* unavailable; skipping (wrong load stage?)");
			return;
		}

		// Idempotency: some loaders read both ccmod.json and package.json and run prestart twice.
		if (window.__ccAimAssistInit) { return; }
		window.__ccAimAssistInit = true;

		// 1) Register the options so they appear in the Assists menu. Added at prestart so the option
		//    model picks up the `init` defaults (and persists them) when it initializes during boot.
		if (sc.OPTIONS_DEFINITION && sc.OPTION_CATEGORY) {
			sc.OPTIONS_DEFINITION[OPT_ENABLED] = {
				type: "CHECKBOX", init: true, cat: sc.OPTION_CATEGORY.ASSISTS,
				hasDivider: true, header: "aimAssist"
			};
			sc.OPTIONS_DEFINITION[OPT_STRENGTH] = {
				type: "ARRAY_SLIDER", data: [0, 1], init: 0.5, cat: sc.OPTION_CATEGORY.ASSISTS,
				fill: true
			};
		} else {
			console.warn("[cc-aim-assist] OPTIONS_DEFINITION/OPTION_CATEGORY missing; menu entries skipped");
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
					catch (e) { console.error("[cc-aim-assist] non-fatal:", e); }
				}
			});
		} else {
			console.warn("[cc-aim-assist] sc.PlayerCrossHairController missing; aim hook skipped");
		}

		// Debug / live-tuning / harness self-test surface.
		window.ccAimAssist = {
			CFG: CFG, LANG: LANG,
			angleDelta: angleDelta, nudgeAngle: nudgeAngle, coneRadFor: coneRadFor,
			selectTarget: selectTarget
		};

		console.log("[cc-aim-assist] loaded (lock-on aim assist + Assists menu options)");
	} catch (e) {
		console.error("[cc-aim-assist] init failed (non-fatal):", e);
	}
})();
