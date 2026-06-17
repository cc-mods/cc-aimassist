// cc-aimassist — poststart.js
// ---------------------------------------------------------------------------
// Surfaces the mod's settings on the CCModManager "Mod settings" page (Mods list → focus this mod →
// right-click / controller R2), NOT in the native game Options/Assists menu. (Suite convention: a
// mod's settings live on its CCModManager page; see cc-mods/cc-agent-tools › crosscode-modding.md.)
//
// HOW THE SETTINGS APPLY
//   CCModManager persists each option to localStorage under "cc-aimassist-<key>" (= "<modId>-<key>")
//   and prestart.js reads those keys LIVE every frame, so changes take effect immediately — no
//   restart. The option keys + the BUTTON_GROUP value map + the defaults are owned by prestart.js
//   (window.ccAimAssist) so the menu and the per-frame logic can never disagree.
//
// WHERE IT RUNS
//   Only when CCModManager is present (it hosts the settings page). Without it this is a clean no-op
//   — the aim assist still runs, using prestart's DEFAULTS (validated Track feel), just with no UI.
(function () {
	"use strict";

	var TAG = "[cc-aimassist]";

	var mm = window.modmanager;
	if (!mm || typeof mm.registerAndGetModOptions !== "function") {
		console.log(TAG + " CCModManager not available; aim-assist settings not registered (assist still runs; defaults apply).");
		return;
	}

	// Shared contract from prestart.js (single source of truth). Fall back to literals if prestart
	// somehow didn't run, so registration never throws.
	var shared = window.ccAimAssist || {};
	var AIM_MODE = shared.AIM_MODE || { OFF: 0, FRICTION: 2, TRACK: 1, HYBRID: 3, STICKY: 4, LOCK: 5 };
	var D = shared.DEFAULTS || { mode: 1, strength: 0.5, range: 0.4, delay: 0.5, distance: 0.5, deadzone: 0.4, lead: false };

	// BUTTON_GROUP label array is indexed by the AIM_MODE VALUE (0..5), matching how the engine's
	// button-group element looks up names — NOT by display/insertion order.
	//   value: 0=Off 1=Track 2=Friction 3=Hybrid 4=Sticky 5=Lock
	var MODE_NAMES = ["Off", "Track", "Friction", "Hybrid", "Sticky", "Lock"];

	// Show an OBJECT_SLIDER's 0..1 value as a percentage on the thumb.
	function pctDisplay(index) {
		var v = 0;
		try {
			if (this && this.data && this.data[index] != null) v = Number(this.data[index]);
			else v = index;
		} catch (e) { v = index; }
		return Math.round(v * 100) + "%";
	}

	function slider(init, name, description) {
		return {
			type: "OBJECT_SLIDER", init: init, min: 0, max: 1, step: 0.05, fill: true,
			name: name, description: description, customNumberDisplay: pctDisplay
		};
	}

	try {
		mm.registerAndGetModOptions(
			{ modId: "cc-aimassist", title: "CrossCode Aim Assist" },
			{
				aimAssist: {
					settings: { tabIcon: "general", title: "Aim Assist" },
					headers: {
						behavior: {
							// BUTTON_GROUP: CCModManager builds buttons from `enum` and stores the selected
							// enum VALUE (0..5) under "cc-aimassist-mode"; prestart switches on that value.
							mode: {
								type: "BUTTON_GROUP",
								enum: AIM_MODE,
								buttonNames: MODE_NAMES,
								init: D.mode,
								name: "Aim Assist",
								// In-game these show on the single-line menu info bar (no wrap) — keep them
								// short. Full detail lives in the README.
								description: "How the game helps your controller aim."
							}
						},
						tuning: {
							strength: slider(D.strength, "Strength",
								"How strong the assist is. 0% = off."),
							range: slider(D.range, "Range",
								"Aim cone width. Lower = must aim closer."),
							delay: slider(D.delay, "Engage Delay",
								"Hold time before it engages. 0% = instant."),
							distance: slider(D.distance, "Max Distance",
								"Max enemy distance to assist."),
							deadzone: slider(D.deadzone, "Deadzone",
								"Hands-off zone when nearly on target.")
						},
						targeting: {
							lead: {
								type: "CHECKBOX", init: D.lead,
								name: "Lead Targets",
								description: "Aim ahead of moving enemies."
							}
						}
					}
				}
			}
		);
		console.log(TAG + " registered aim-assist settings in CCModManager.");
	} catch (e) {
		// Never let a settings-registration failure surface as a game error.
		console.error(TAG + " failed to register mod settings (non-fatal):", e);
	}
})();
