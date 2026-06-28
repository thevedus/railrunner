#!/usr/bin/env bash
# Railrunner — register this container as a GitHub Actions self-hosted runner,
# then hand off to the official run.sh. Reuses config.sh/run.sh from the base
# image (ghcr.io/actions/actions-runner), which runs as the `runner` user in
# /home/runner and already bundles curl + jq.
set -euo pipefail

API="${GITHUB_API_URL:-https://api.github.com}"
RUNNER_SCOPE="${RUNNER_SCOPE:-repo}"
RUNNER_NAME="${RUNNER_NAME:-railrunner-$(hostname)}"
RUNNER_LABELS="${RUNNER_LABELS:-railway,railrunner}"
EPHEMERAL="${EPHEMERAL:-true}"
DISABLE_AUTO_UPDATE="${DISABLE_AUTO_UPDATE:-true}"

# Resolve the registration URL and the API path used to mint tokens.
case "$RUNNER_SCOPE" in
  repo)
    [[ -n "${REPO_URL:-}" ]] || { echo "ERROR: RUNNER_SCOPE=repo requires REPO_URL (e.g. https://github.com/owner/repo)" >&2; exit 1; }
    REG_URL="$REPO_URL"
    API_PATH="repos/${REPO_URL#https://github.com/}"
    ;;
  org)
    [[ -n "${ORG_NAME:-}" ]] || { echo "ERROR: RUNNER_SCOPE=org requires ORG_NAME" >&2; exit 1; }
    REG_URL="https://github.com/${ORG_NAME}"
    API_PATH="orgs/${ORG_NAME}"
    ;;
  *)
    echo "ERROR: RUNNER_SCOPE must be 'repo' or 'org' (got '$RUNNER_SCOPE')" >&2; exit 1 ;;
esac

# A PAT (ACCESS_TOKEN) mints a fresh registration token every start — this is
# what lets the runner survive Railway restarts. A raw RUNNER_TOKEN works too
# but expires ~1h after you copy it, so it's for quick tests only.
if [[ -n "${ACCESS_TOKEN:-}" ]]; then
  REG_TOKEN="$(curl -fsSL -X POST \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "${API}/${API_PATH}/actions/runners/registration-token" | jq -r '.token')"
elif [[ -n "${RUNNER_TOKEN:-}" ]]; then
  REG_TOKEN="$RUNNER_TOKEN"
else
  echo "ERROR: set ACCESS_TOKEN (a PAT, recommended) or RUNNER_TOKEN (short-lived)" >&2; exit 1
fi

[[ -n "$REG_TOKEN" && "$REG_TOKEN" != "null" ]] || { echo "ERROR: could not obtain a registration token — check ACCESS_TOKEN permissions and REPO_URL/ORG_NAME" >&2; exit 1; }

args=(--unattended --replace --url "$REG_URL" --token "$REG_TOKEN" --name "$RUNNER_NAME" --labels "$RUNNER_LABELS")
if [[ -n "${RUNNER_GROUP:-}" ]]; then args+=(--runnergroup "$RUNNER_GROUP"); fi
if [[ "${EPHEMERAL,,}" == "true" ]]; then args+=(--ephemeral); fi
if [[ "${DISABLE_AUTO_UPDATE,,}" == "true" ]]; then args+=(--disableupdate); fi

./config.sh "${args[@]}"

# exec so SIGTERM from Railway reaches run.sh, which stops the runner cleanly.
exec ./run.sh
