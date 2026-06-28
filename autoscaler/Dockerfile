# Railrunner autoscaler — Bun runtime + the Railway CLI, which performs the
# replica change as a graceful staged patch (no full redeploy). No third-party
# npm deps: the app uses Bun's built-in fetch and Bun.spawn.
FROM oven/bun:1
USER root

ARG RAILWAY_CLI_VERSION=5.23.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL "https://github.com/railwayapp/cli/releases/download/v${RAILWAY_CLI_VERSION}/railway-v${RAILWAY_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
    | tar -xz -C /usr/local/bin \
 && chmod +x /usr/local/bin/railway \
 && railway --version \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json autoscale.ts ./

ENTRYPOINT ["bun", "run", "autoscale.ts"]
