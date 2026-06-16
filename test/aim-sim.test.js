/* Headless Node integration test for cc-aimassist (no game, no WKWebView, no window).
 *
 * Loads prestart.js in a VM with stubbed sc/ig, then drives the REAL applyAssist frame-by-frame
 * against fake enemies — exercising the full per-frame path (mode dispatch, target selection, dwell,
 * deadzone, Lead, and the spread-neutralization of crosshair._lastDir) for every mode. This replaces
 * the WKWebView macOS harness for local verification. Run: `node test/aim-sim.test.js` (or `npm test`).
 *
 * Two frame models mirror how the engine feeds the hook:
 *   - frameHold(cmd): the player holds/sweeps the stick — coll.pos is (re)set to the commanded angle
 *     each frame, then applyAssist adjusts it. Used for Friction/Sticky/Lock/Lead.
 *   - frameAccumulate(): the assist's own output persists into the next frame (conservative model of
 *     the engine's gamepad lerp, which starts from the previous crosshair offset). Used to show the
 *     Track/Hybrid angular *pull* converges toward the target and settles.
 */
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var src = fs.readFileSync(path.join(__dirname, "..", "prestart.js"), "utf8");

// Mutable stubs the test drives per scenario.
var OPTS = {};
var sandbox = {
	console: { log: function () {}, warn: function () {}, error: function () {} },
	Math: Math,
	window: {},
	ig: { Lang: { inject: function () {} }, game: { entities: [] } },
	sc: {
		options: { get: function (k) { return OPTS[k]; } },
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
var M = A.AIM_MODE;

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error("  FAIL: " + name); } }

// --- option registration (headless) --------------------------------------------------
(function () {
	var D = sandbox.sc.OPTIONS_DEFINITION;
	ok("registers all 7 options", ["mode", "strength", "range", "delay", "distance", "deadzone", "lead"]
		.every(function (s) { return D["aim-assist-" + s] != null; }));
	ok("mode is BUTTON_GROUP, default Track", D["aim-assist-mode"].type === "BUTTON_GROUP" && D["aim-assist-mode"].init === M.TRACK);
	ok("mode data is AIM_MODE", D["aim-assist-mode"].data === M);
	ok("sliders are ARRAY_SLIDER [0,1]", ["strength", "range", "delay", "distance", "deadzone"]
		.every(function (s) { var o = D["aim-assist-" + s]; return o.type === "ARRAY_SLIDER" && o.data[0] === 0 && o.data[1] === 1; }));
	ok("lead is CHECKBOX init false", D["aim-assist-lead"].type === "CHECKBOX" && D["aim-assist-lead"].init === false);
	ok("all options in ASSISTS category", ["mode", "strength", "range", "delay", "distance", "deadzone", "lead"]
		.every(function (s) { return D["aim-assist-" + s].cat === sandbox.sc.OPTION_CATEGORY.ASSISTS; }));
})();

// --- harness helpers -----------------------------------------------------------------
function setOpts(mode, o) {
	o = o || {};
	OPTS["aim-assist-mode"] = mode;
	OPTS["aim-assist-strength"] = o.strength != null ? o.strength : 1;
	OPTS["aim-assist-range"] = o.range != null ? o.range : 1;       // wide cone unless overridden
	OPTS["aim-assist-delay"] = o.delay != null ? o.delay : 0;       // instant unless overridden
	OPTS["aim-assist-distance"] = o.distance != null ? o.distance : 0.5;
	OPTS["aim-assist-deadzone"] = o.deadzone != null ? o.deadzone : 0;
	OPTS["aim-assist-lead"] = !!o.lead;
}
function enemy(angle, d, vx, vy, combat, party) {
	d = d || 200;
	var cx = Math.cos(angle) * d, cy = Math.sin(angle) * d;
	return { isCombatant: combat !== false, party: party != null ? party : sandbox.sc.COMBATANT_PARTY.ENEMY,
		isDefeated: function () { return false; }, coll: { vel: { x: vx || 0, y: vy || 0 } },
		getCenter: function (v) { v.x = cx; v.y = cy; return v; } };
}
function newCtrl() { return { gamepadMode: true }; }
function newCh(angle, d) {
	return { active: true, coll: { pos: { x: Math.cos(angle) * d, y: Math.sin(angle) * d } },
		_lastDir: { x: 0, y: 0 }, _getThrowerPos: function (v) { v.x = 0; v.y = 0; return v; } };
}
function aimOf(ch) { return Math.atan2(ch.coll.pos.y, ch.coll.pos.x); }
var DIST = 100;
function frameHold(ctrl, ch, cmd) {
	ch.coll.pos.x = Math.cos(cmd) * DIST; ch.coll.pos.y = Math.sin(cmd) * DIST;
	A.applyAssist(ctrl, ch);
	return aimOf(ch);
}
function frameAccumulate(ctrl, ch) { A.applyAssist(ctrl, ch); return aimOf(ch); }

// --- OFF: no change ------------------------------------------------------------------
(function () {
	setOpts(M.OFF);
	sandbox.ig.game.entities = [enemy(0.10)];
	var c = newCtrl(), h = newCh(0, DIST);
	var r = frameHold(c, h, 0);
	ok("OFF does nothing", r === 0);
})();

// --- TRACK: pulls toward an in-cone enemy, settles at the deadzone, ignores decoys ----
(function () {
	setOpts(M.TRACK, { deadzone: 0.4 });                 // deadzone 0.4 -> ~1.6deg
	var tgt = 0.30;
	sandbox.ig.game.entities = [
		enemy(0.05, 200, 0, 0, false),                   // non-combatant decoy (closer)
		enemy(-0.06, 200, 0, 0, true, sandbox.sc.COMBATANT_PARTY.OTHER), // OTHER-party decoy
		enemy(tgt)                                        // the real enemy
	];
	var c = newCtrl(), h = newCh(0, DIST), prev = 0, moved = false, overshot = false;
	for (var i = 0; i < 80; i++) {
		var a = frameAccumulate(c, h);
		if (a > prev + 1e-9) moved = true;
		if (a > tgt + 1e-6) overshot = true;
		prev = a;
	}
	ok("TRACK converges toward the enemy", prev > 0.27 && prev <= tgt + 1e-6);
	ok("TRACK never overshoots the target", !overshot);
	ok("TRACK ignored non-enemy decoys (settled at enemy angle)", Math.abs(prev - tgt) < 0.03);
	ok("TRACK neutralizes spread (_lastDir aligned to new aim)", Math.abs(Math.atan2(h._lastDir.y, h._lastDir.x) - prev) < 1e-6);
})();

// --- TRACK deadzone: hands-off when already dead-on ----------------------------------
(function () {
	setOpts(M.TRACK, { deadzone: 1 });                   // deadzone 1 -> 4deg
	sandbox.ig.game.entities = [enemy(0)];               // enemy dead-ahead
	var c = newCtrl(), h = newCh(0.02, DIST);            // aim 0.02rad (~1.1deg) off -> inside deadzone
	var a = frameHold(c, h, 0.02);
	ok("TRACK deadzone leaves fine aim alone", Math.abs(a - 0.02) < 1e-9);
})();

// --- FRICTION: damps a steadily sweeping stick (realized lags commanded) --------------
(function () {
	setOpts(M.FRICTION);
	sandbox.ig.game.entities = [enemy(0.40)];
	var c = newCtrl(), h = newCh(0, DIST), cmd = 0, realized = 0;
	for (var i = 0; i < 16; i++) { cmd += 0.02; realized = frameHold(c, h, cmd); }
	ok("FRICTION lags a sweeping stick", realized < cmd - 0.02 && realized > 0);
})();

// --- HYBRID: also converges toward the enemy (pull layer) -----------------------------
(function () {
	setOpts(M.HYBRID, { deadzone: 0.4 });
	var tgt = 0.30;
	sandbox.ig.game.entities = [enemy(tgt)];
	var c = newCtrl(), h = newCh(0, DIST), prev = 0;
	for (var i = 0; i < 80; i++) prev = frameAccumulate(c, h);
	ok("HYBRID converges toward the enemy", prev > 0.25 && prev <= tgt + 1e-6);
})();

// --- STICKY: compresses a held offset toward the target, and follows a moving target --
(function () {
	setOpts(M.STICKY);
	var off = 0.35;                                      // you hold aim 0.35rad off a target at 0
	sandbox.ig.game.entities = [enemy(0)];
	var c = newCtrl(), h = newCh(off, DIST), a = 0;
	for (var i = 0; i < 30; i++) a = frameHold(c, h, off);
	ok("STICKY compresses your offset toward the target", a > 0.01 && a < off - 0.1);
	var compressed = a;
	// move the target by +0.20 with the SAME held stick offset -> output shifts with it
	sandbox.ig.game.entities = [enemy(0.20)];
	var h2 = newCh(0.20 + off, DIST), a2 = 0;
	var c2 = newCtrl();
	for (var j = 0; j < 30; j++) a2 = frameHold(c2, h2, 0.20 + off);
	ok("STICKY follows a moving target", Math.abs((a2 - 0.20) - compressed) < 0.02);
})();

// --- LOCK: snaps onto the nearest enemy ----------------------------------------------
(function () {
	setOpts(M.LOCK, { strength: 0.5 });
	sandbox.ig.game.entities = [enemy(0.17)];
	var c = newCtrl(), h = newCh(0, DIST), a = 0;
	for (var i = 0; i < 4; i++) a = frameHold(c, h, 0);
	ok("LOCK snaps to the enemy", Math.abs(a - 0.17) < 1e-3);
})();

// --- LEAD: aims ahead of a moving enemy ----------------------------------------------
(function () {
	setOpts(M.TRACK, { lead: true, deadzone: 0 });
	sandbox.ig.game.entities = [enemy(0, 200, 0, 150)];  // enemy dead-ahead, moving +y at 150px/s
	var c = newCtrl(), h = newCh(0, 200), prev = 0;
	for (var i = 0; i < 80; i++) prev = frameAccumulate(c, h);
	var predicted = Math.atan2(45, 200);                 // 150*0.30 = 45px lead
	ok("LEAD aims ahead of a strafing enemy", prev > 0.12 && Math.abs(prev - predicted) < 0.03);
})();

// --- range / distance gating ---------------------------------------------------------
(function () {
	setOpts(M.LOCK, { range: 0.2 });                     // ~9.2deg cone
	sandbox.ig.game.entities = [enemy(0.30)];            // 17deg -> outside cone
	var c = newCtrl(), h = newCh(0, DIST);
	ok("out-of-cone enemy is not engaged", frameHold(c, h, 0) === 0);

	setOpts(M.LOCK, { distance: 0 });                    // ~200px max
	sandbox.ig.game.entities = [enemy(0.05, 300)];       // in cone but 300px away
	var c2 = newCtrl(), h2 = newCh(0, DIST);
	ok("out-of-range enemy is not engaged", frameHold(c2, h2, 0) === 0);
})();

// --- dwell (Engage Delay): assist ramps in rather than snapping on ---------------------
(function () {
	setOpts(M.TRACK, { delay: 0.8, deadzone: 0 });       // long dwell
	sandbox.ig.game.entities = [enemy(0.20)];
	var c = newCtrl(), h = newCh(0, DIST);
	var first = frameHold(c, h, 0);                      // frame 1: blend tiny
	for (var i = 0; i < 8; i++) frameHold(c, h, 0);      // hold near the enemy to fill dwell
	var later = frameHold(c, h, 0);                      // frame 10: blend larger
	ok("dwell ramps the assist in (later step > first step)", later > first && first >= 0);
})();

console.log((fail === 0 ? "ok" : "FAILED") + " — aim-sim: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
