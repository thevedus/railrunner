#!/usr/bin/env bun
// Railrunner autoscaler — poll GitHub for demand across one or more repos (or a
// whole org), then set the runner service's replica count on Railway via the
// `railway` CLI. The CLI applies the change as a graceful staged patch: new
// replicas start on the existing image, and drained ones finish their current
// job first — so scaling never kills a live job.
//
// Stateless by design: every tick recomputes the target straight from GitHub, so
// a missed or slow reading simply self-corrects on the next pass.

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "railrunner-autoscaler",
  "X-GitHub-Api-Version": "2022-11-28",
};

/** Clamp demand into [min, max]. The one bit of logic worth a test — see autoscale.test.ts. */
export function desiredReplicas(demand: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, demand));
}

/** Normalize a repo reference to "owner/repo" (accepts full URLs, .git, trailing slashes). */
export function normalizeRepo(ref: string): string {
  return ref.trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

async function ghJson(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...GH_HEADERS } });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** List an org's active (non-archived, non-disabled) repos, following pagination. */
async function listOrgRepos(org: string, token: string): Promise<string[]> {
  const repos: string[] = [];
  for (let page = 1; ; page++) {
    const batch = (await ghJson(
      `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`,
      token,
    )) as Array<{ full_name: string; archived: boolean; disabled: boolean }>;
    for (const r of batch) if (!r.archived && !r.disabled) repos.push(r.full_name);
    if (batch.length < 100) break;
  }
  return repos;
}

/** Total workflow runs that are queued or in progress across the given repos. */
export async function countDemand(repos: string[], token: string): Promise<number> {
  const count = async (slug: string, status: string): Promise<number> => {
    const data = await ghJson(
      `https://api.github.com/repos/${slug}/actions/runs?status=${status}&per_page=1`,
      token,
    );
    return (data.total_count as number | undefined) ?? 0;
  };
  const parts = await Promise.all(
    repos.flatMap((slug) => [count(slug, "queued"), count(slug, "in_progress")]),
  );
  return parts.reduce((a, b) => a + b, 0);
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
  const serviceId = reqEnv("RUNNER_SERVICE_ID");
  const region = process.env.RUNNER_REGION ?? "us-west";
  const min = intEnv("MIN_RUNNERS", 1);
  const max = intEnv("MAX_RUNNERS", 5);
  const poll = intEnv("POLL_SECONDS", 20);
  const refresh = intEnv("REPO_REFRESH_SECONDS", 300);
  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

  // What to watch: an explicit list (REPOS, or legacy REPO_URL) and/or a whole org.
  const listed = (process.env.REPOS ?? process.env.REPO_URL ?? "")
    .split(",").map(normalizeRepo).filter(Boolean);
  const org = process.env.GITHUB_ORG?.trim();

  if (!process.env.RAILWAY_TOKEN && !process.env.RAILWAY_API_TOKEN) {
    console.error("Missing RAILWAY_TOKEN — create a Railway project token so the railway CLI can scale.");
    process.exit(1);
  }
  if (listed.length === 0 && !org) {
    console.error("Set REPOS (comma-separated owner/repo) and/or GITHUB_ORG to watch.");
    process.exit(1);
  }
  if (min > max) { console.error(`MIN_RUNNERS (${min}) > MAX_RUNNERS (${max})`); process.exit(1); }

  const watching = [listed.join(", "), org ? `org:${org}` : ""].filter(Boolean).join(" + ");
  console.log(
    `railrunner autoscaler: watching ${watching}; scaling ${serviceId} in ${region}, ` +
    `min=${min} max=${max}, every ${poll}s${dryRun ? " (DRY RUN)" : ""}`,
  );

  let orgRepos: string[] = [];
  let lastRefresh = 0;
  let applied = -1;

  for (;;) {
    try {
      if (org && Date.now() - lastRefresh > refresh * 1000) {
        orgRepos = await listOrgRepos(org, githubToken);
        lastRefresh = Date.now();
        console.log(`org ${org}: ${orgRepos.length} active repos`);
      }
      const repos = [...new Set([...listed, ...orgRepos])];
      if (repos.length === 0) {
        console.log("no repos to watch yet");
      } else {
        const demand = await countDemand(repos, githubToken);
        const want = desiredReplicas(demand, min, max);
        console.log(`repos=${repos.length} demand=${demand} -> desired=${want}${want === applied ? " (no change)" : ""}`);
        if (want !== applied) {
          await setReplicas(serviceId, region, want, dryRun);
          applied = want;
        }
      }
    } catch (e) {
      console.error("tick error:", (e as Error).message);
    }
    await Bun.sleep(poll * 1000);
  }
}

if (import.meta.main) await main();
