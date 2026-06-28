# Railrunner — a self-hosted GitHub Actions runner for Railway.
# The official image already bundles the runner, curl and jq and runs as the
# non-root `runner` user in /home/runner, so we only add the registration glue.
# Pin to a release tag if you want reproducible builds, e.g. :2.330.0
FROM ghcr.io/actions/actions-runner:latest

# --chmod needs BuildKit (default on Railway and GitHub Actions buildx).
COPY --chmod=755 entrypoint.sh /home/runner/entrypoint.sh

ENTRYPOINT ["/home/runner/entrypoint.sh"]
