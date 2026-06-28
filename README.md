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

Run a second tiny service that watches your job queue and adjusts how many runner replicas Railway runs — up under load, back down (even to zero) when idle.

```
GitHub Actions          autoscaler (autoscaler/)                    Railway
  queued jobs  ──poll──▶  desired = clamp(demand, MIN, MAX)  ──scale──▶  runner replicas
```

It **polls** every ~20s and is **stateless** — each check recomputes the target from GitHub, so there's nothing to drift out of sync. Scaling goes through the `railway` CLI, which applies the change gracefully: new replicas start on the existing image, and drained ones finish their current job first.

### Deploy it

1. In the **same Railway project** as your runner, add another service from this repo.
2. Set its **Root Directory** to `autoscaler`.
3. Create a Railway **project token** (Project → Settings → Tokens) and add the env vars below.

| Variable | Default | What |
|---|---|---|
| `GITHUB_TOKEN` | — | PAT with **Actions: Read** on the repo |
| `REPO_URL` | — | `https://github.com/owner/repo` to watch |
| `RAILWAY_TOKEN` | — | a Railway **project token** (lets the CLI scale) |
| `RUNNER_SERVICE_ID` | — | the **runner** service's ID (Service → Settings) |
| `RUNNER_REGION` | `us-west` | region your runner runs in (`us-west`, `us-east`, `eu-west`, `southeast-asia`) |
| `MIN_RUNNERS` | `1` | floor — set `0` to scale to zero when idle |
| `MAX_RUNNERS` | `5` | ceiling (safety cap) |
| `POLL_SECONDS` | `20` | how often to check |
| `DRY_RUN` | `false` | log decisions without scaling — flip on first to watch it think |

Tip: deploy with `DRY_RUN=true` and read the logs (`demand=… -> desired=…`) until you trust it, then turn it off.

### What it deliberately keeps simple

- **Demand is counted per workflow _run_** (one cheap API call each for queued + in-progress). A single run with many matrix jobs counts once — `MAX` caps the gap and the warm pool drains the rest. Per-job counting is the obvious upgrade.
- **Repo-scoped** — it watches one `REPO_URL`. Org-wide autoscaling needs a different demand query.
- **It counts all of the repo's runs**, so if you also use GitHub-hosted runners in the same repo it may scale up for jobs it can't serve. Dedicate the repo (or its self-hosted jobs) for the cleanest behavior.
- **Single region** — it scales `RUNNER_REGION` only.
- At high volume you'd swap polling for `workflow_job` webhooks; the loop in [`autoscaler/autoscale.ts`](autoscaler/autoscale.ts) is small and easy to change.

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
