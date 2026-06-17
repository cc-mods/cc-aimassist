# Copilot instructions — cc-aimassist

Part of the **[cc-mods](https://github.com/cc-mods)** CrossCode suite (controller aim assist mod).

📓 **Read the suite agent docs first:**
**[`cc-mods/cc-agent-tools`](https://github.com/cc-mods/cc-agent-tools)** (private; org members only) is the
source of truth for hard-won findings — start at its
[`AGENTS.md`](https://github.com/cc-mods/cc-agent-tools/blob/main/AGENTS.md). Most relevant here:
- [`crosscode-modding.md`](https://github.com/cc-mods/cc-agent-tools/blob/main/crosscode-modding.md) —
  CCLoader load stages (this mod patches `sc.PlayerCrossHairController` in **`prestart`**), the
  fatal-404 asset rule, valid tags, cross-platform detection.
- [`suite-architecture.md`](https://github.com/cc-mods/cc-agent-tools/blob/main/suite-architecture.md) —
  why mods have no cross-dependencies.

**When you learn something durable, add it to `cc-mods/cc-agent-tools`** and keep this pointer intact.

## What this is

A pure-logic CCLoader mod (ships no assets) that hooks gamepad aiming in `prestart.js`: each frame it
rotates the crosshair toward the nearest enemy within a cone **preserving aim distance**, and tells
the spread system "nothing moved" so the snap never widens spread. Pure math is exported on
`window.ccAimAssist` for testing. Settings live on the mod's **CCModManager → Mod settings** page.

## Must-not-break

- cc-ios compatibility is required: core-engine APIs only (no NW.js/iOS specifics), ship **no
  assets**, all hooks + callbacks in try/catch so a mod error never reaches game init.
- Ship both `ccmod.json` and `package.json`; keep versions in sync. Valid CCModDB tags only
  (`QoL`, `accessibility`). id `cc-aimassist` == repo name — don't rename. Root-level layout.
- No game assets / personal data / secrets in commits.

## Release

Push to `main` auto-bumps the patch, tags, builds `cc-aimassist-<ver>.ccmod`, publishes a Release.
**The release bot pushes the bump commit back — `git pull --rebase origin main` before your next
push.** Docs-only paths (`**.md`, `.github/**`, `LICENSE`) are excluded. After a release, rebuild
`cc-mods/CCModDB`. `tools/build-ccmod.sh` builds locally.

## Verify

`node --check prestart.js`; validate JSON manifests; prove in the cc-ios macOS harness
(`bootstrap=true platform=Browser jsErrors=0`, no `CRITICAL BUG`). See `HANDOFF.md` for engine
internals.
