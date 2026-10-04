#!/usr/bin/env bash
# Existing deterministic acceptance only; see README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
phase=Preflight
[[ $# -eq 0 ]] || { echo 'Usage: ./scripts/verify-redwood.sh' >&2; exit 2; }
identity=$(node scripts/package-source.mjs check)
node scripts/package-source.mjs git
finish() {
  code=$?
  node scripts/package-source.mjs check "$identity" >/dev/null || code=1
  node scripts/package-source.mjs git >/dev/null || code=1
  if [[ $code -eq 0 ]]; then
    echo 'REDWOOD_PUBLIC_DISTRIBUTION_VERIFICATION=PASS'
  else
    printf '[Redwood] FAILED: %s (exit %s)\n' "$phase" "$code" >&2
  fi
  exit "$code"
}
trap finish EXIT
for tool in node npm git sandbox-exec; do
  command -v "$tool" >/dev/null || { echo "Missing $tool; see README.md." >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw Error("Node >=24 required")'
for package in launcher products/build products/studio products/grow integrations/media; do
  [[ -d $package/node_modules ]] || {
    echo "Missing dependencies: run npm ci --prefix $package --ignore-scripts --no-audit --no-fund separately." >&2; exit 1;
  }
done
for binary in "${FFMPEG_PATH:-ffmpeg}" "${FFPROBE_PATH:-ffprobe}"; do
  command -v "$binary" >/dev/null || { echo "Missing $binary; see README.md." >&2; exit 1; }
done
node --input-type=module -e '
import {createRequire} from "node:module"; import {accessSync} from "node:fs";
const require = createRequire(process.cwd() + "/products/build/package.json");
try { accessSync(require("@playwright/test").chromium.executablePath()); }
catch { throw Error("Prepare Chromium separately: cd products/build && npx playwright install chromium"); }'
mkdir -p launcher/.local
out=$(mktemp -d "$root/launcher/.local/verify-redwood.XXXXXX")
printf '[Redwood] Logs: %s\n' "$out"
# Preserve the baseline's two documented opt-in skips; never load an ASR model.
unset STUDIO_ASR_TEST STUDIO_CAPTURE_TEST STUDIO_CAPTURE_R2_EVIDENCE
export npm_config_offline=true npm_config_audit=false npm_config_fund=false
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
profile="$root/scripts/loopback-only.sb"
run() {
  local label=$1; shift
  printf '[Redwood] %s: %s\n' "$phase" "$label"
  local code=0
  "$@" >"$out/$label.log" 2>&1 || code=$?
  if [[ $code -ne 0 ]]; then echo "[Redwood] Failed command: $label (exit $code)" >&2; tail -n 60 "$out/$label.log"; return "$code"; fi
}
offline() { sandbox-exec -f "$profile" "$@"; }
phase=Build; echo '[Redwood] Build'
(cd products/build
 run build-tests offline node node_modules/vitest/vitest.mjs run --config tests/agent-git/vitest.config.ts
 run build-restore offline node node_modules/vitest/vitest.mjs run --config tests/git-restore-r6/vitest.config.ts
 run build-typecheck offline npm run typecheck
 run build-build offline npm run build)
phase=Present; echo '[Redwood] Present'
(cd products/studio
 # The native Chromium sandbox is required by capture-r2; the other tests use loopback only.
 tests=(tests/*.test.js tests/*/*.test.js)
 ordinary=(); for test in "${tests[@]}"; do [[ $test == tests/capture-r2/* ]] || ordinary+=("$test"); done
 run present-tests offline node --test --test-reporter=tap --test-concurrency=1 "${ordinary[@]}"
 run present-capture node --test --test-reporter=tap --test-concurrency=1 tests/capture-r2/*.test.js
 run present-check offline npm run check)
phase=Grow; echo '[Redwood] Grow'
(cd products/grow
 run grow-tests offline node --test --test-reporter=tap --test-concurrency=1 tests/*.test.js tests/*/*.test.js
 run grow-check offline npm run check
 run grow-typecheck offline npm run typecheck)
phase=Integrations; echo '[Redwood] Integrations'
run media offline node --test --test-reporter=tap tests/media-connectors/*.test.mjs
run owner-adapters offline node --test --test-reporter=tap integrations/media/tests/integration.test.mjs integrations/resume/tests/owner-adapters.test.mjs
run media-runtime offline node --test --test-reporter=tap integrations/media/tests/runtime.test.mjs
LF_EVIDENCE_DIR="$out/leaf" run resume-doctor-connectors offline node launcher/tests/leaf-regression.mjs
phase=Advisor; echo '[Redwood] Advisor'
run advisor offline node --test tests/advisor/*.test.mjs
phase=Launcher; echo '[Redwood] Launcher'
run launcher-tests offline npm --prefix launcher test
run launcher-typecheck offline npm --prefix launcher run typecheck
run launcher-build offline npm --prefix launcher run build
for suite in shell support direct-entry convergence connections-observations; do
  LF_EVIDENCE_DIR="$out/$suite" run "$suite-browser" node "launcher/tests/$suite-browser.mjs"
done
phase=Static; echo '[Redwood] Static'
run wrapper-syntax bash -n scripts/verify-redwood.sh
run distribution-tests offline node --test scripts/package-source.test.mjs
