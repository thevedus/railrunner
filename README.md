# Railrunner

Deploy a **self-hosted GitHub Actions runner** on [Railway](https://railway.com) by pasting one token. Built on the official [`actions/actions-runner`](https://github.com/actions/runner) image — Railrunner adds only the ~40 lines of registration glue.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)

## Why

GitHub-hosted runners are fine until you want more minutes, a fixed IP, persistent caches, or a bigger box. Railrunner runs a runner as a Railway service: deploy, set two env vars, done. Ephemeral by default — a clean runner per job.

## Deploy

Two ways — pick one.

**A. From this repo (Railway builds it).** New Project → *Deploy from GitHub repo* → `thevedus/railrunner`. Railway builds the Dockerfile and redeploys on every push.

**B. From the prebuilt image.** New Project → *Deploy a Docker image* → `ghcr.io/thevedus/railrunner:latest`.

Then add the env vars below. The service needs **no port** — it's a worker.

## Configure

Set **either** `ACCESS_TOKEN` (recommended) **or** `RUNNER_TOKEN`, plus a target.

| Variable | Required | Default | What |
|---|---|---|---|
| `REPO_URL` | repo runners | — | `https://github.com/owner/repo` |
| `RUNNER_SCOPE` | org runners | `repo` | set to `org` |
| `ORG_NAME` | org runners | — | org login (with `RUNNER_SCOPE=org`) |
| `ACCESS_TOKEN` | ✅ recommended | — | a **PAT**; mints a fresh registration token each start, so the runner survives restarts |
| `RUNNER_TOKEN` | alt | — | a raw registration token; **expires ~1h**, quick tests only |
| `RUNNER_NAME` | | `railrunner-<host>` | display name in GitHub |
| `RUNNER_LABELS` | | `railway,railrunner` | comma-separated; target with `runs-on:` |
| `RUNNER_GROUP` | | — | runner group (org) |
| `EPHEMERAL` | | `true` | one job, then re-register |
| `DISABLE_AUTO_UPDATE` | | `true` | pin the runner version |

### Getting a token

**PAT (recommended).** Create a fine-grained token → *Repository access* = your repo → *Permissions* → **Administration: Read and write** (repo runners), or organization **Self-hosted runners: Read and write** (org runners). Set it as `ACCESS_TOKEN`.

**Raw token (quick test).** Repo or org → Settings → Actions → Runners → *New self-hosted runner* → copy the value after `--token`. Set it as `RUNNER_TOKEN` and deploy within the hour.

Target the runner from a workflow:

```yaml
jobs:
  build:
    runs-on: [self-hosted, railrunner]
```

## Autoscaling (optional)

Run a second tiny service that listens for GitHub **`workflow_job`** webhooks and adjusts how many runner replicas Railway runs — up the instant jobs are queued, back down (even to zero) when they finish.

```
GitHub Actions                  autoscaler (autoscaler/)               Railway
  workflow_job ──webhook──▶  active jobs ──clamp(n, MIN, MAX)──scale──▶  runner replicas
```

It's **event-driven** (no API polling, so no rate limits), **job-accurate** (counts individual `workflow_job`s, filtered by label), and reacts in seconds. One **org-level** webhook covers every repo in the org — that's how you autoscale across many repos. Scaling goes through the `railway` CLI, which applies the change gracefully: new replicas start on the existing image, and drained ones finish their current job first.

### Deploy it

1. In the **same Railway project** as your runner, add another service from this repo and set its **Root Directory** to `autoscaler`.
2. Give it a public URL: Service → Settings → Networking → **Generate Domain**, and copy it.
3. Add the env vars below (full list in [`autoscaler/.env.example`](autoscaler/.env.example)) — including a `GITHUB_WEBHOOK_SECRET` you choose and a `RAILWAY_TOKEN` (Project → Settings → Tokens).
4. Add the webhook in GitHub — **repo** *or* **org** → Settings → Webhooks → Add webhook:
   - **Payload URL**: your Railway domain (e.g. `https://xxx.up.railway.app/`)
   - **Content type**: `application/json`
   - **Secret**: the same `GITHUB_WEBHOOK_SECRET`
   - **Events**: "Let me select individual events" → **Workflow jobs** only

   > Railway's "Suggested Variables" can't auto-detect every variable — add `GITHUB_WEBHOOK_SECRET` and `RUNNER_SERVICE_ID` yourself, and don't set `RAILWAY_API_TOKEN` (only one Railway token is allowed) or `RAILWAY_CLI_VERSION` (build-time only).

| Variable | Default | What |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | — | shared secret; must match the webhook's **Secret** |
| `RAILWAY_TOKEN` | — | a Railway **project token** (lets the CLI scale) |
| `RUNNER_SERVICE_ID` | — | the **runner** service's ID (Service → Settings) |
| `RUNNER_REGION` | `us-west` | region your runner runs in (`us-west`, `us-east`, `eu-west`, `southeast-asia`) |
| `RUNNER_LABELS` | `railrunner` | only count jobs whose `runs-on` includes these labels |
| `MIN_RUNNERS` | `1` | floor — set `0` to scale to zero when idle |
| `MAX_RUNNERS` | `5` | ceiling (safety cap) |
| `JOB_TTL_SECONDS` | `3600` | drop a job we never saw finish (covers a missed event); raise above your longest job |
| `DRY_RUN` | `false` | log decisions without scaling — flip on first to watch it think |

Tip: deploy with `DRY_RUN=true`, push a job, and watch the logs (`queued job … -> active=1`) before turning it off.

### Finding the values

- **`RUNNER_SERVICE_ID`** — open the **runner** service and copy the UUID from its URL: `railway.com/project/…/service/`**`<this-id>`**. Not the autoscaler's own ID — Railway already injects that as `RAILWAY_SERVICE_ID`, which is exactly why this one is named `RUNNER_SERVICE_ID`.
- **`RUNNER_REGION`** — runner service → Settings → Regions.
- **`RAILWAY_TOKEN`** — mint one under Project → Settings → Tokens (or keep Railway's pre-filled value). It's a secret — don't commit or share it.

### What it deliberately keeps simple

- **Job-accurate and label-filtered** — each `workflow_job` is counted by its `id`, and only if its labels include every entry in `RUNNER_LABELS` — so it ignores GitHub-hosted jobs and counts matrix jobs individually.
- **No polling, no GitHub token** — GitHub pushes the events, so there's no API rate limit and one org webhook scales the whole org. The only credentials it needs are the Railway token (to scale) and the webhook secret (to trust GitHub).
- **In-memory state, self-healing** — the active-job set lives in memory; a missed `completed` event is cleaned up by `JOB_TTL_SECONDS`, and a restart briefly drops to `MIN_RUNNERS` then rebuilds as new events arrive (Railway's graceful drain means running jobs are never killed).
- **Single region** — it scales `RUNNER_REGION` only.
- Bursts (a big matrix) are coalesced into one scale call; the whole server is ~120 lines in [`autoscaler/autoscale.ts`](autoscaler/autoscale.ts).

## ⚠️ Limitations & security

- **No Docker-in-Docker on Railway.** Railway containers aren't privileged and there's no host Docker socket, so jobs that run `docker build` or use `container:` / service containers **won't work**. Plain build / test / lint / deploy jobs are fine.
- **Never point a self-hosted runner at a public repo.** Anyone who opens a PR can run arbitrary code on it and exfiltrate your `ACCESS_TOKEN`. Use private repos, and require approval for outside-collaborator PRs (Settings → Actions → *Fork pull request workflows*).
- Ephemeral runners (default) auto-deregister after each job; Railway's `ALWAYS` restart policy (set in [`railway.json`](railway.json)) brings up a fresh one for the next job.

## Run locally

```bash
docker run --rm \
  -e REPO_URL=https://github.com/owner/repo \
  -e ACCESS_TOKEN=github_pat_... \
  ghcr.io/thevedus/railrunner
```

## Publish the image / one-click template

CI ([`.github/workflows/build.yml`](.github/workflows/build.yml)) pushes `ghcr.io/thevedus/railrunner` on every push to `main`. To let others deploy it:

1. Make the GHCR package public: org → Packages → `railrunner` → Package settings → Change visibility → Public.
2. *(Optional)* Publish a Railway template from your dashboard (Account → Templates) pointing at this repo or image and exposing the env vars above, then swap the **Deploy on Railway** button URL for your template link.

## License

MIT — see [LICENSE](LICENSE).
