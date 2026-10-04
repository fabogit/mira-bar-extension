#!/usr/bin/env bash
# Verification run on macOS (Apple Silicon): every step in order, stopping at the first failure.
# Writes one self-contained Markdown report to docs/verification/<date>-macos-<sha>.md, meant to be
# committed as history: summary, warnings, skips, leak test, VSIX contents and the full output of every
# step. Does not modify sources, commit or push.
#
#   bash test/verify-macos.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
command -v pnpm >/dev/null || { echo "pnpm not found: corepack enable  or  npm i -g pnpm@11" >&2; exit 1; }

SHA="$(git rev-parse --short HEAD)"
DAY="$(date +%Y-%m-%d)"
mkdir -p "$ROOT/docs/verification"
REPORT="$ROOT/docs/verification/$DAY-macos-$SHA.md"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
STARTED="$(date '+%Y-%m-%d %H:%M %Z')"
DIRTY_AT_START="$(git status --porcelain --untracked-files=no)"

NAMES=(install typecheck build compile:native test test:host test:soak leak-darwin package:darwin-arm64)
CMDS=("pnpm install --frozen-lockfile" "pnpm run typecheck" "pnpm run build" "pnpm run compile:native"
  "pnpm test" "pnpm run test:host" "pnpm run test:soak" "node --expose-gc test/leak-darwin.mjs"
  "pnpm run package:darwin-arm64")
# Skips: node:test marks a skipped test or suite with "﹣ <name> (<time>) # <reason>"; the scripts print ": skipped".
SKIPPED='(:|;) skipped|^ *﹣ '
RESULTS=(); DURATIONS=(); FAILED=""

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"; out="$TMP/$i.out"
  if [ -n "$FAILED" ]; then RESULTS[$i]="not run"; DURATIONS[$i]="-"; continue; fi
  printf '\n========== %s: %s\n' "$name" "${CMDS[$i]}"
  t0=$SECONDS
  bash -c "${CMDS[$i]}" 2>&1 | tee "$out"
  rc=${PIPESTATUS[0]}
  DURATIONS[$i]="$((SECONDS - t0)) s"
  sed -i '' -e $'s/\x1b\\[[0-9;]*m//g' "$out" 2>/dev/null || sed -i -e $'s/\x1b\\[[0-9;]*m//g' "$out"
  [ "$name" = "leak-darwin" ] && grep -q 'LEAK?' "$out" && [ "$rc" -eq 0 ] && rc=99
  if [ "$rc" -ne 0 ]; then RESULTS[$i]="**FAILED** (exit $rc)"; FAILED="$name"
  elif grep -q -E "$SKIPPED" "$out"; then RESULTS[$i]="OK, with skips"
  else RESULTS[$i]="OK"; fi
done

section() {  # section <grep -E pattern> [grep options]: matching lines of every step, grouped by step
  local pattern="$1"; shift; local found=""
  for i in "${!NAMES[@]}"; do
    [ -f "$TMP/$i.out" ] || continue
    if grep -q -E "$@" "$pattern" "$TMP/$i.out"; then
      found=1; echo "**${NAMES[$i]}**"; echo; echo '```'; grep -E "$@" "$pattern" "$TMP/$i.out"; echo '```'; echo
    fi
  done
  [ -n "$found" ] || { echo "None."; echo; }
}
step_out() { local i; for i in "${!NAMES[@]}"; do [ "${NAMES[$i]}" = "$1" ] && [ -f "$TMP/$i.out" ] && cat "$TMP/$i.out"; done; }

{
  echo "# macOS verification, $DAY"
  echo
  echo "- Commit: \`$(git rev-parse HEAD)\` on \`$(git rev-parse --abbrev-ref HEAD)\`: $(git log -1 --format=%s)"
  echo "- Run: $STARTED, with \`bash test/verify-macos.sh\`"
  echo "- Mac: $(sysctl -n machdep.cpu.brand_string 2>/dev/null), $(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d GB", $1/1073741824}'), macOS $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null)), $(uname -m)"
  echo "- Node $(node -v), pnpm $(pnpm -v), $(clang++ --version 2>/dev/null | head -1), SDK $(xcrun --show-sdk-version 2>/dev/null)"
  echo "- Tracked files modified before the run: $([ -z "$DIRTY_AT_START" ] && echo none || echo yes)"
  echo "- Outcome: $([ -z "$FAILED" ] && echo "**all steps passed**" || echo "**stopped at \`$FAILED\`**")"
  echo
  echo "| # | Step | Command | Result | Time |"
  echo "|---|---|---|---|---|"
  for i in "${!NAMES[@]}"; do
    echo "| $((i + 1)) | ${NAMES[$i]} | \`${CMDS[$i]}\` | ${RESULTS[$i]} | ${DURATIONS[$i]} |"
  done
  echo
  echo "## Compiler warnings"
  echo
  echo "clang++ with \`-Wall -Wextra -Wunguarded-availability-new\` (\`compile:native\`, again in \`package:darwin-arm64\`)."
  echo
  section 'warning:|error:' -A2
  echo "## Other warnings"
  echo
  echo "Tool and runtime warnings (pnpm, Node, vsce)."
  echo
  section 'WARN|Warning|deprecated|Ignored build scripts'
  echo "## Skipped"
  echo
  section "$SKIPPED"
  echo "## Leak test (\`leak-darwin.mjs\`)"
  echo
  if [ -n "$(step_out leak-darwin)" ]; then
    echo '```'; step_out leak-darwin | sed -n '/┌/,/└/p'; echo; step_out leak-darwin | sed -n '/^Host port/,$p'; echo '```'
  else echo "Not run."; fi
  echo
  echo "## VSIX"
  echo
  if [ -n "$(step_out package:darwin-arm64)" ]; then
    echo '```'; step_out package:darwin-arm64 | sed -n '/Files included in the VSIX/,$p'
    vsix="$(ls -t "$ROOT"/*.vsix 2>/dev/null | head -1)"
    [ -n "$vsix" ] && echo && echo "SHA-256 $(shasum -a 256 "$vsix" | cut -d' ' -f1)  $(basename "$vsix")"
    echo '```'
  else echo "Not built."; fi
  echo
  echo "## Manual checks in VS Code"
  echo
  echo "To fill in after installing the VSIX (\`code --install-extension <vsix>\`, then *Developer: Reload Window*)."
  echo
  echo "- [ ] Status bar: CPU, frequency, temperature, memory, battery, disk and the gear, in order, with plausible values"
  echo "- [ ] Temperature shown from the first refresh after activation (#44)"
  echo "- [ ] Tooltips (Live and Static) and the settings panel work; settings written to the right scope (#42)"
  echo "- [ ] Output channel *MiraBar*: \"Activated\", no native addon warnings (#46)"
  echo "- [ ] Extension host CPU in Process Explorer below 1% of a core with the defaults"
  echo
  echo "Notes:"
  echo
  echo "## Output of every step"
  echo
  for i in "${!NAMES[@]}"; do
    [ -f "$TMP/$i.out" ] || continue
    echo "<details><summary>$((i + 1)). ${NAMES[$i]}: ${RESULTS[$i]//\*/}</summary>"
    echo; echo '```'; cat "$TMP/$i.out"; echo '```'; echo; echo "</details>"; echo
  done
} | sed "s#$HOME#~#g" > "$REPORT"

echo; echo "Report: ${REPORT#$ROOT/}"
[ -z "$FAILED" ]
