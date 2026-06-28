#!/usr/bin/env bun
// Railrunner autoscaler — poll GitHub for demand, then set the runner service's
// replica count on Railway via the `railway` CLI. The CLI applies the change as
// a graceful staged patch: new replicas start on the existing image, and drained
// replicas finish their current job first — so scaling never kills a live job.
//
// Stateless by design: every tick recomputes the target straight from GitHub, so
// a missed or slow reading simply self-corrects on the next pass. The entire
// control loop is `main()` at the bottom; the only real logic is `desiredReplicas`.

/** Clamp demand into [min, max]. The one bit of logic worth a test — see autoscale.test.ts. */
export function desiredReplicas(demand: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, demand));
}

/** Count workflow runs that are queued or in progress (run-level — see README caveats). */
export async function countDemand(repoApi: string, token: string): Promise<number> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "railrunner-autoscaler",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const count = async (status: string): Promise<number> => {
    const res = await fetch(`${repoApi}/actions/runs?status=${status}&per_page=1`, { headers });
    if (!res.ok) throw new Error(`GitHub ${status} -> ${res.status} ${await res.text()}`);
    return ((await res.json()) as { total_count?: number }).total_count ?? 0;
  };
  const [queued, running] = await Promise.all([count("queued"), count("in_progress")]);
  return queued + running;
}

function reqEnv(key: string): string {
  const v = process.env[key];
  if (!v) { console.error(`Missing required env: ${key}`); process.exit(1); }
  return v;
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n)) { console.error(`${key} must be a number, got "${raw}"`); process.exit(1); }
  return n;
}

/** Apply the replica count by shelling out to the Railway CLI. */
async function setReplicas(serviceId: string, region: string, n: number, dryRun: boolean): Promise<void> {
  const args = ["scale", "--service", serviceId, `${region}=${n}`];
  if (dryRun) { console.log(`[dry-run] railway ${args.join(" ")}`); return; }
  const proc = Bun.spawn(["railway", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`railway scale failed (exit ${code}): ${(err || out).trim()}`);
  console.log(`scaled ${serviceId} -> ${region}=${n}`);
}

async function main(): Promise<void> {
  const githubToken = reqEnv("GITHUB_TOKEN");
  const repoUrl = reqEnv("REPO_URL");
  const serviceId = reqEnv("RUNNER_SERVICE_ID");
  const region = process.env.RUNNER_REGION ?? "us-west";
  const min = intEnv("MIN_RUNNERS", 1);
  const max = intEnv("MAX_RUNNERS", 5);
  const poll = intEnv("POLL_SECONDS", 20);
  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

  // The CLI reads RAILWAY_TOKEN itself; we only fail fast if it's missing.
  if (!process.env.RAILWAY_TOKEN && !process.env.RAILWAY_API_TOKEN) {
    console.error("Missing RAILWAY_TOKEN — create a Railway project token so the railway CLI can scale.");
    process.exit(1);
  }
  if (min > max) { console.error(`MIN_RUNNERS (${min}) > MAX_RUNNERS (${max})`); process.exit(1); }

  const slug = repoUrl.replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/, "");
  const repoApi = `https://api.github.com/repos/${slug}`;

  console.log(
    `railrunner autoscaler: watching ${slug}, scaling service ${serviceId} in ${region}, ` +
    `min=${min} max=${max}, every ${poll}s${dryRun ? " (DRY RUN)" : ""}`,
  );

  let applied = -1;
  for (;;) {
    try {
      const demand = await countDemand(repoApi, githubToken);
      const want = desiredReplicas(demand, min, max);
      console.log(`demand=${demand} -> desired=${want}${want === applied ? " (no change)" : ""}`);
      if (want !== applied) {
        await setReplicas(serviceId, region, want, dryRun);
        applied = want;
      }
    } catch (e) {
      console.error("tick error:", (e as Error).message);
    }
    await Bun.sleep(poll * 1000);
  }
}

if (import.meta.main) await main();
