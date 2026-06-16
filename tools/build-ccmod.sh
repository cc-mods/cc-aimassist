#!/usr/bin/env bash
# Build a distributable .ccmod from the mod source at the repo ROOT.
#
# A .ccmod is just a ZIP with ccmod.json at the archive root. The same artifact installs on
# desktop CrossCode (via CCLoader / CCModManager) and on cc-ios (via the in-game Mods tab or
# tools/setup-ccloader.sh --add-mod).
#
# Usage:
#   tools/build-ccmod.sh            # -> dist/cc-aimassist-<version>.ccmod
#   tools/build-ccmod.sh -o OUT     # write to a specific path
#
# No game assets are bundled (this mod ships none), so the archive is tiny and safe to share.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out=""

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) out="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[ -f "$repo_root/ccmod.json" ] || { echo "error: $repo_root/ccmod.json not found" >&2; exit 1; }
[ -f "$repo_root/prestart.js" ] || { echo "error: $repo_root/prestart.js not found" >&2; exit 1; }

# Read id + version from the manifest (validates JSON via python3).
read -r id version < <(python3 - "$repo_root/ccmod.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
print(m.get("id", "cc-aimassist"), m.get("version", "0.0.0"))
PY
)

# Syntax-check prestart.js if a JS engine is available (node), so we never ship a broken mod.
if command -v node >/dev/null 2>&1; then
  node --check "$repo_root/prestart.js"
  echo "prestart.js: syntax OK"
fi

if [ -z "$out" ]; then
  mkdir -p "$repo_root/dist"
  out="$repo_root/dist/${id}-${version}.ccmod"
fi
mkdir -p "$(dirname "$out")"
rm -f "$out"

# Stage only the runtime + docs (ccmod.json at the archive root), then zip — so dev-only files
# (tools/, .github/, HANDOFF.md, dist/, .git/) never ship in the package.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
for f in ccmod.json package.json prestart.js icon.png README.md LICENSE; do
  [ -f "$repo_root/$f" ] && cp "$repo_root/$f" "$stage/"
done
( cd "$stage" && zip -rq "$out" . -x '.DS_Store' -x '__MACOSX/*' -x '*.map' )

echo "Built: $out"
echo "Contents:"
unzip -l "$out" | sed 's/^/  /'
cat <<EOF

Install:
  desktop  CrossCode/assets/mods/  (drop the .ccmod in, CCLoader unpacks it) — or use CCModManager.
  cc-ios   in-game Mods tab, or:  tools/setup-ccloader.sh --add-mod $repo_root
After launching, check the JS console for "[cc-aimassist] loaded".
EOF
