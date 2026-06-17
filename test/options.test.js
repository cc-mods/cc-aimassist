/* Headless Node tests for cc-aimassist settings (no game, no browser, no window).
 *
 * Covers the migration of settings from the native Assists menu to the CCModManager "Mod settings"
 * page:
 *   - poststart.js registers the mode BUTTON_GROUP + 5 OBJECT_SLIDERs + the Lead CHECKBOX under one
 *     category, with the option KEYS that derive the localStorage ids "cc-aimassist-<key>" that
 *     prestart.js reads. Verifies the BUTTON_GROUP stores the AIM_MODE value map and the slider
 *     percent display.
 *   - prestart.js reads those localStorage keys live, with the right type coercion + defaults.
 *
 * Run: `node test/options.test.js` (or `npm test`).
 */
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error("  FAIL: " + name); } }

function fakeLocalStorage(initial) {
	var store = Object.assign({}, initial);
	return {
		getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
		setItem: function (k, v) { store[k] = String(v); },
		removeItem: function (k) { delete store[k]; },
		_store: store
	};
}
function run(file, sandbox) {
	var src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: file });
	return sandbox;
}

// Load prestart first (it defines window.ccAimAssist that poststart reads), then poststart with a
// stubbed CCModManager that captures the registered schema.
function load(opts) {
	opts = opts || {};
	var registered = null;
	var win = {
		localStorage: fakeLocalStorage(opts.ls || {}),
		ccAimAssist: undefined
	};
	var sc = {
		COMBATANT_PARTY: { PLAYER: 1, ENEMY: 2, OTHER: 3 },
		PlayerCrossHairController: { inject: function () {} }
	};
	run("prestart.js", { console: { log: function () {}, warn: function () {}, error: function () {} }, window: win, ig: {}, sc: sc });
	win.modmanager = opts.noModmanager ? undefined : {
		registerAndGetModOptions: function (info, schema) { registered = { info: info, schema: schema }; return {}; }
	};
	var post = { console: { log: function () {}, warn: function () {}, error: function () {} }, window: win };
	if (opts.sc) post.sc = opts.sc;
	if (opts.ig) post.ig = opts.ig;
	run("poststart.js", post);
	return { registered: registered, win: win, ccuw: win.ccAimAssist };
}

// ---- poststart: CCModManager registration -------------------------------------------
(function () {
	var r = load();
	var reg = r.registered;
	ok("registers with CCModManager", !!reg);
	ok("modId + title", reg && reg.info.modId === "cc-aimassist");

	var headers = reg && reg.schema.aimAssist && reg.schema.aimAssist.headers;
	ok("single category 'aimAssist'", !!headers);

	// Option KEYS must be exactly these (they derive localStorage ids cc-aimassist-<key>).
	var mode = headers && headers.behavior && headers.behavior.mode;
	var tuning = headers && headers.tuning;
	var lead = headers && headers.targeting && headers.targeting.lead;

	ok("mode is BUTTON_GROUP", !!mode && mode.type === "BUTTON_GROUP");
	ok("mode enum is AIM_MODE (value map)", mode && mode.enum && mode.enum.TRACK === 1 && mode.enum.OFF === 0 && mode.enum.LOCK === 5);
	ok("mode default = Track (1)", mode && mode.init === 1);
	// buttonNames indexed by VALUE: [0]=Off [1]=Track [2]=Friction [3]=Hybrid [4]=Sticky [5]=Lock
	ok("buttonNames value-indexed", mode && mode.buttonNames[0] === "Off" && mode.buttonNames[1] === "Track" &&
		mode.buttonNames[2] === "Friction" && mode.buttonNames[5] === "Lock");
	// Per-value hints: one short line per mode, value-indexed like buttonNames, each within the
	// single-line info-bar budget (~80 chars).
	ok("buttonDescriptions value-indexed + short", mode && Array.isArray(mode.buttonDescriptions) &&
		mode.buttonDescriptions.length === 6 &&
		/manual/i.test(mode.buttonDescriptions[0]) && /snap/i.test(mode.buttonDescriptions[5]) &&
		mode.buttonDescriptions.every(function (d) { return typeof d === "string" && d.length > 0 && d.length <= 80; }));

	var sliderKeys = ["strength", "range", "delay", "distance", "deadzone"];
	ok("five OBJECT_SLIDERs 0..1 step .05", sliderKeys.every(function (k) {
		var o = tuning && tuning[k];
		return o && o.type === "OBJECT_SLIDER" && o.min === 0 && o.max === 1 && o.step === 0.05;
	}));
	ok("slider defaults match prestart DEFAULTS", tuning &&
		tuning.strength.init === 0.5 && tuning.range.init === 0.4 && tuning.delay.init === 0.5 &&
		tuning.distance.init === 0.5 && tuning.deadzone.init === 0.4);
	ok("slider percent display", tuning && tuning.strength.customNumberDisplay.call({ data: { 10: 0.5 } }, 10) === "50%");
	ok("lead is CHECKBOX init false", lead && lead.type === "CHECKBOX" && lead.init === false);

	// No CCModManager -> clean no-op (no throw, nothing registered).
	var threw = false;
	try { load({ noModmanager: true }); } catch (e) { threw = true; }
	ok("no-op without CCModManager", !threw);
})();

// ---- prestart: live reads of cc-aimassist-<key> with coercion + defaults -------------
(function () {
	// Absent keys -> DEFAULTS.
	var d = load().ccuw;
	ok("default mode = Track", d.optNum(d.KEYS.mode, d.DEFAULTS.mode) === 1);
	ok("default strength = 0.5", d.optNum(d.KEYS.strength, d.DEFAULTS.strength) === 0.5);
	ok("default lead = false", d.optBool(d.KEYS.lead, d.DEFAULTS.lead) === false);

	// Present keys -> parsed values (numbers for sliders/mode, bool for lead).
	var p = load({ ls: {
		"cc-aimassist-mode": "5", "cc-aimassist-strength": "0.25", "cc-aimassist-lead": "true"
	} }).ccuw;
	ok("reads persisted mode (Lock=5)", p.optNum(p.KEYS.mode, p.DEFAULTS.mode) === 5);
	ok("reads persisted strength", p.optNum(p.KEYS.strength, p.DEFAULTS.strength) === 0.25);
	ok("reads persisted lead=true", p.optBool(p.KEYS.lead, p.DEFAULTS.lead) === true);

	// Garbage -> default.
	var g = load({ ls: { "cc-aimassist-range": "xyz" } }).ccuw;
	ok("bad numeric -> default", g.optNum(g.KEYS.range, g.DEFAULTS.range) === g.DEFAULTS.range);
})();

// ---- poststart: per-value BUTTON_GROUP hint patch ------------------------------------
// Simulate the engine's native button-group renderer + impact.js `inject`, then prove the patch
// rewrites each value button's description from buttonDescriptions — and leaves other groups alone.
(function () {
	// Minimal impact.js-style class: inject() wraps a method and exposes the prior impl as this.parent.
	function NativeButtonGroup() {}
	NativeButtonGroup.prototype.init = function (optionRow, _width, _rowGroup) {
		// Native behaviour: build buttons[value] with the SINGLE option description on each.
		this.buttons = [];
		var data = optionRow.option.data; // value list
		for (var k in data) {
			var value = data[k];
			this.buttons[value] = { data: { description: optionRow.optionDes, id: value, row: optionRow.row } };
		}
	};
	NativeButtonGroup.inject = function (props) {
		for (var name in props) {
			(function (name, fn, orig) {
				NativeButtonGroup.prototype[name] = function () {
					var tmp = this.parent; this.parent = orig;
					var ret = fn.apply(this, arguments); this.parent = tmp; return ret;
				};
			})(name, props[name], NativeButtonGroup.prototype[name]);
		}
	};

	var fakeSc = {
		COMBATANT_PARTY: { PLAYER: 1, ENEMY: 2, OTHER: 3 },
		PlayerCrossHairController: { inject: function () {} },
		OPTION_TYPES: { BUTTON_GROUP: "buttongroup" },
		OPTION_GUIS: { buttongroup: NativeButtonGroup }
	};
	var r = load({ sc: fakeSc, ig: {} });
	var mode = r.registered.schema.aimAssist.headers.behavior.mode;

	ok("patch installed on BUTTON_GROUP", NativeButtonGroup.__ccAimAssistHintPatch === true);

	// Render the Aim Assist mode group: native stamps the generic desc, then the patch personalises.
	var values = [0, 1, 2, 3, 4, 5];
	var inst = new NativeButtonGroup();
	inst.init(
		{ option: { data: values }, optionName: "mode", optionDes: mode.description, row: 0, guiOption: mode },
		300, {}
	);
	ok("each mode button gets its own hint", values.every(function (v) {
		return inst.buttons[v] && inst.buttons[v].data.description === mode.buttonDescriptions[v];
	}));
	ok("Off button -> Off hint", /manual/i.test(inst.buttons[0].data.description));
	ok("Lock button -> Lock hint", /snap/i.test(inst.buttons[5].data.description));

	// Safety: a DIFFERENT button group (no buttonDescriptions) is left untouched — keeps the
	// option's single description on every button, exactly like vanilla.
	var other = new NativeButtonGroup();
	other.init(
		{ option: { data: [0, 1] }, optionName: "x", optionDes: "Plain option desc.", row: 0, guiOption: { /* no buttonDescriptions */ } },
		300, {}
	);
	ok("group without buttonDescriptions is unchanged", other.buttons[0].data.description === "Plain option desc." &&
		other.buttons[1].data.description === "Plain option desc.");

	// Idempotent: loading again must not double-wrap / re-patch.
	var before = NativeButtonGroup.prototype.init;
	load({ sc: fakeSc, ig: {} });
	ok("patch is idempotent", NativeButtonGroup.prototype.init === before);
})();

console.log((fail === 0 ? "ok" : "FAILED") + " — options: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
