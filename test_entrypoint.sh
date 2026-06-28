#!/usr/bin/env bash
# Runnable check for entrypoint.sh's validation branches. No network and no
# config.sh needed — every case errors out before registration is attempted.
set -u
EP="$(cd "$(dirname "$0")" && pwd)/entrypoint.sh"
pass=0; fail=0

check() { # $1=description  $2=expected substring  $3...=VAR=VAL
  local desc="$1" want="$2"; shift 2
  local out rc
  out="$(env -i PATH="$PATH" "$@" bash "$EP" 2>&1)"; rc=$?
  if [[ $rc -ne 0 && "$out" == *"$want"* ]]; then
    echo "ok   - $desc"; pass=$((pass+1))
  else
    echo "FAIL - $desc (rc=$rc) got: $out"; fail=$((fail+1))
  fi
}

check "repo scope needs REPO_URL"  "requires REPO_URL"        RUNNER_SCOPE=repo
check "org scope needs ORG_NAME"   "requires ORG_NAME"        RUNNER_SCOPE=org
check "bad scope rejected"         "must be 'repo' or 'org'"  RUNNER_SCOPE=bogus
check "needs a token"              "ACCESS_TOKEN"             RUNNER_SCOPE=repo REPO_URL=https://github.com/o/r

echo "---"; echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
