/* Node unit tests for cc-aimassist pure aiming math (no game, no deps).
 *
 * Loads prestart.js with stubbed window/sc/ig/console so the IIFE runs its wire-up and exports
 * window.ccAimAssist, then exercises the game-agnostic helpers. Run: `node test/aim-math.test.js`
 * (or `npm test`). The live engine behavior is proven separately in the cc-ios macOS harness.
 */
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var src = fs.readFileSync(path.join(__dirname, "..", "prestart.js"), "utf8");

// Minimal stubs: enough for the prestart wire-up to run and export window.ccAimAssist.
var sandbox = {
	console: { log: function () {}, warn: function () {}, error: function () {} },
	Math: Math,
	window: {},
	ig: { Lang: { inject: function () {} } },
	sc: {
		options: { get: function () { return 0; } },
		OPTIONS_DEFINITION: {},
		OPTION_CATEGORY: { ASSISTS: 6 },
		COMBATANT_PARTY: { PLAYER: 1, ENEMY: 2, OTHER: 3 },
		PlayerCrossHairController: { inject: function () {} }
	}
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "prestart.js" });

var A = sandbox.window.ccAimAssist;
var DEG = Math.PI / 180;

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error("  FAIL: " + name); } }
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }
function deg(rad) { return rad / DEG; }

// --- exports present -----------------------------------------------------------------
ok("exports present", !!(A && A.selectTarget && A.trackStep && A.frictionStep && A.stickyStep &&
	A.leadAngle && A.coneRadFor && A.distPxFor && A.dwellFramesFor && A.deadzoneRadFor && A.pullFor &&
	A.capRadFor && A.frictionFor && A.stickyFollowFor && A.AIM_MODE));

var M = A.AIM_MODE;
var C = A.CFG;

// --- mode enum: 6 single-select modes, stable values, TRACK default == 1 -------------
ok("mode OFF=0", M.OFF === 0);
ok("mode TRACK=1 (stable)", M.TRACK === 1);
ok("six distinct modes", new Set([M.OFF, M.FRICTION, M.TRACK, M.HYBRID, M.STICKY, M.LOCK]).size === 6);
// (The mode button labels now live in poststart.js and are checked in options.test.js.)

// --- angleDelta: shortest signed arc, wraps across PI ---------------------------------
ok("angleDelta zero", approx(A.angleDelta(1, 1), 0));
ok("angleDelta +90", approx(A.angleDelta(0, Math.PI / 2), Math.PI / 2));
ok("angleDelta wraps the short way", approx(A.angleDelta(-3.0, 3.0), -0.283185, 1e-5));

// --- slider (0..1) -> tunable mappings ------------------------------------------------
ok("coneRadFor 0 = min", approx(deg(A.coneRadFor(0)), C.coneMinDeg, 1e-6));
ok("coneRadFor 1 = max", approx(deg(A.coneRadFor(1)), C.coneMaxDeg, 1e-6));
ok("coneRadFor 0.4 ~ 14.4deg", approx(deg(A.coneRadFor(0.4)), 14.4, 1e-6));
ok("coneRadFor clamps >1", approx(deg(A.coneRadFor(5)), C.coneMaxDeg, 1e-6));
ok("distPxFor 0 = min", approx(A.distPxFor(0), C.distMinPx, 1e-6));
ok("distPxFor 1 = max", approx(A.distPxFor(1), C.distMaxPx, 1e-6));
ok("distPxFor 0.5 = 600", approx(A.distPxFor(0.5), 600, 1e-6));
ok("dwellFramesFor 0 = 0 (instant)", A.dwellFramesFor(0) === 0);
ok("dwellFramesFor 0.5 ~ 10 frames", A.dwellFramesFor(0.5) === 10);
ok("dwellFramesFor 1 ~ 19 frames", A.dwellFramesFor(1) === 19);
ok("deadzoneRadFor 0 = 0", approx(A.deadzoneRadFor(0), 0));
ok("deadzoneRadFor 0.4 = 1.6deg", approx(deg(A.deadzoneRadFor(0.4)), 1.6, 1e-6));
ok("pullFor scales with strength", approx(A.pullFor(0.5), 0.5 * C.trackPullMax, 1e-9));
ok("pullFor 0 = 0", approx(A.pullFor(0), 0));
ok("capRadFor 0 = min", approx(deg(A.capRadFor(0)), C.trackCapMinDeg, 1e-6));
ok("capRadFor 1 = max", approx(deg(A.capRadFor(1)), C.trackCapMaxDeg, 1e-6));
ok("frictionFor 1 = max", approx(A.frictionFor(1), C.frictionMax, 1e-9));
ok("stickyFollowFor 1 = max", approx(A.stickyFollowFor(1), C.stickyFollowMax, 1e-9));
ok("stickyFollowFor 0 = 0", approx(A.stickyFollowFor(0), 0));

// --- trackStep: eases toward target, capped per frame, scaled by blend ---------------
(function () {
	var aim = 0, target = 60 * DEG;
	var s1 = A.trackStep(aim, target, 0.1, 90 * DEG, 1);     // 0.1 * 60 = 6deg this frame
	ok("track eases a fraction toward target", deg(s1) > 5.5 && deg(s1) < 6.5);
	ok("track moves in the correct direction", s1 > 0);
	var s2 = A.trackStep(aim, target, 1.0, 2 * DEG, 1);      // cap clamps the big step
	ok("track per-frame cap clamps", approx(deg(s2), 2, 1e-6));
	var s3 = A.trackStep(aim, target, 0.5, 90 * DEG, 0);     // blend 0 -> nothing
	ok("track blend 0 = no move", approx(s3, aim, 1e-9));
})();

// --- frictionStep: removes a fraction of the stick's angular motion ------------------
(function () {
	var prev = 0, aim = 10 * DEG;
	ok("friction f=0 keeps full motion", approx(A.frictionStep(prev, aim, 0), aim, 1e-9));
	ok("friction f=1 freezes aim", approx(A.frictionStep(prev, aim, 1), prev, 1e-9));
	ok("friction f=0.5 halves motion", approx(deg(A.frictionStep(prev, aim, 0.5)), 5, 1e-6));
})();

// --- stickyStep: compresses your offset from the target, glued by follow*blend --------
(function () {
	var base = 0, aim = 20 * DEG;                            // you're aiming 20deg off the target
	ok("sticky follow*blend 0 = aim unchanged", approx(A.stickyStep(base, aim, 0, 1), aim, 1e-9));
	ok("sticky follow*blend 1 = glued to base", approx(A.stickyStep(base, aim, 1, 1), base, 1e-9));
	ok("sticky 0.85 compresses offset", approx(deg(A.stickyStep(base, aim, 0.85, 1)), 20 * 0.15, 1e-6));
	ok("sticky blend scales the glue", approx(deg(A.stickyStep(base, aim, 1, 0.5)), 10, 1e-6));
	// as the target (base) moves, output follows it even with the same stick offset
	var s1 = A.stickyStep(0, 20 * DEG, 0.85, 1), s2 = A.stickyStep(10 * DEG, 30 * DEG, 0.85, 1);
	ok("sticky follows a moving target", approx(s2 - s1, 10 * DEG, 1e-6));
})();

// --- leadAngle: aims ahead of a moving enemy -----------------------------------------
(function () {
	// enemy at (100,0) moving +y at 100px/s; from origin, 0.3s ahead -> (100,30) -> atan2(30,100)
	var la = A.leadAngle(100, 0, 0, 100, 0.3, 0, 0);
	ok("leadAngle leads a moving enemy", approx(la, Math.atan2(30, 100), 1e-9));
	// zero velocity -> current angle
	ok("leadAngle no velocity = current", approx(A.leadAngle(100, 0, 0, 0, 0.3, 0, 0), 0, 1e-9));
})();

// --- selectTarget: enemy picking, cone, range, hysteresis, distance tiebreak ----------
(function () {
	var cone = 14 * DEG, R = 1000;
	var pick = A.selectTarget(0, 0, 0, cone, R, -1, [{ x: 100, y: 0 }, { x: 0, y: 100 }], 2);
	ok("selects enemy inside cone", !!(pick && pick.idx === 0));

	var none = A.selectTarget(0, 0, 0, cone, R, -1, [{ x: 0, y: 100 }], 1);
	ok("nothing when all outside cone", none === null);

	var far = A.selectTarget(0, 0, 0, cone, 300, -1, [{ x: 350, y: 0 }], 1);
	ok("excludes enemy beyond Max Distance", far === null);
	var near = A.selectTarget(0, 0, 0, cone, 300, -1, [{ x: 250, y: 0 }], 1);
	ok("includes enemy within Max Distance", !!(near && near.idx === 0));

	var tie = A.selectTarget(0, 0, 0, cone, R, -1, [{ x: 300, y: 0 }, { x: 120, y: 0 }], 2);
	ok("near enemy wins an angle tie", !!(tie && tie.idx === 1));

	// held target just outside the tight cone but inside the release cone -> kept
	var heldAng = 18 * DEG;
	var held = [{ x: Math.cos(heldAng) * 100, y: Math.sin(heldAng) * 100 }, { x: 100, y: 0 }];
	var stick = A.selectTarget(0, 0, 0, cone, R, 0, held, 2);
	ok("sticky lock holds previous target in release cone", !!(stick && stick.idx === 0));

	// held target now outside the release cone -> switch to the in-cone candidate
	var goneAng = 30 * DEG;
	var gone = [{ x: Math.cos(goneAng) * 100, y: Math.sin(goneAng) * 100 }, { x: 100, y: 0 }];
	var sw = A.selectTarget(0, 0, 0, cone, R, 0, gone, 2);
	ok("drops held target outside release cone", !!(sw && sw.idx === 1));
})();

console.log((fail === 0 ? "ok" : "FAILED") + " — aim-math: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
