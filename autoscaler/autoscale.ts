#!/usr/bin/env bun
// Railrunner autoscaler (webhook mode) — GitHub sends a `workflow_job` event for
// every job that is queued, starts, or finishes. We keep the set of jobs that
// currently need a runner and set the runner service's replica count to match
// (clamped to [MIN, MAX]) via the `railway` CLI. Job-accurate, label-filtered,
// instant, and no API polling — so one org webhook can scale a whole org.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Clamp demand into [min, max]. */
export function desiredReplicas(demand: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, demand));
}

/** Verify GitHub's X-Hub-Signature-256 over the raw body, in constant time. */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True if the job requests every one of our marker labels (so it targets our runner). */
export function jobMatches(jobLabels: string[], markers: string[]): boolean {
  return markers.every((m) => jobLabels.includes(m));
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

/** Run a railway CLI command; throw with its output on failure. */
async function railway(args: string[]): Promise<string> {
  const proc = Bun.spawn(["railway", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`railway ${args[0]} failed (exit ${code}): ${(err || out).trim()}`);
  return (out || err).trim();
}

/** Link this project + environment + service so `railway scale` has context.
 * The CLI's `scale --project/--environment` flags don't set context on their own
 * (scale needs a *linked* project); Railway injects these IDs into the service. */
async function railwayLink(serviceId: string): Promise<void> {
  const project = process.env.RAILWAY_PROJECT_ID;
  const env = process.env.RAILWAY_ENVIRONMENT_ID ?? process.env.RAILWAY_ENVIRONMENT;
  if (!project || !env) {
    console.warn("RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID not set — can't link; scaling will fail. (Running outside Railway?)");
    return;
  }
  await railway(["link", "--project", project, "--environment", env, "--service", serviceId]);
  console.log(`linked project=${project} env=${env} service=${serviceId}`);
}

/** Set the linked runner service's replica count in one region. */
async function railwayScale(region: string, n: number, dryRun: boolean): Promise<void> {
  if (dryRun) { console.log(`[dry-run] railway scale ${region}=${n}`); return; }
  await railway(["scale", `${region}=${n}`]);
  console.log(`scaled -> ${region}=${n}`);
}

async function main(): Promise<void> {
  const secret = reqEnv("GITHUB_WEBHOOK_SECRET");
  const serviceId = reqEnv("RUNNER_SERVICE_ID");
  const region = process.env.RUNNER_REGION ?? "us-west";
  const markers = (process.env.RUNNER_LABELS ?? "railrunner").split(",").map((s) => s.trim()).filter(Boolean);
  const min = intEnv("MIN_RUNNERS", 1);
  const max = intEnv("MAX_RUNNERS", 5);
  const ttlMs = intEnv("JOB_TTL_SECONDS", 3600) * 1000;
  const debounceMs = intEnv("DEBOUNCE_MS", 2000);
  const port = intEnv("PORT", 8080);
  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

  if (!process.env.RAILWAY_API_TOKEN && !process.env.RAILWAY_TOKEN) {
    console.error("Missing RAILWAY_API_TOKEN — create a Railway account or workspace token so the railway CLI can scale (a project token returns 'Unauthorized').");
    process.exit(1);
  }
  if (min > max) { console.error(`MIN_RUNNERS (${min}) > MAX_RUNNERS (${max})`); process.exit(1); }

  // jobId -> expiry timestamp. A job is "active" (needs a runner) while queued or
  // in progress; the TTL covers any `completed` event we never received.
  const jobs = new Map<number, number>();
  let applied = -1;
  let scaling = false;
  let dirty = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  async function applyScale(): Promise<void> {
    if (scaling) { dirty = true; return; }
    scaling = true;
    try {
      do {
        dirty = false;
        const want = desiredReplicas(jobs.size, min, max);
        if (want !== applied) { await railwayScale(region, want, dryRun); applied = want; }
      } while (dirty);
    } catch (e) {
      console.error("scale error:", (e as Error).message);
    } finally {
      scaling = false;
    }
  }

  function scheduleScale(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void applyScale(); }, debounceMs);
  }

  // Evict jobs whose `completed` event we missed, so phantoms don't pin the count high.
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, exp] of jobs) if (exp <= now) { jobs.delete(id); changed = true; }
    if (changed) scheduleScale();
  }, 60_000);

  // Establish project/environment/service context so `railway scale` works.
  try { await railwayLink(serviceId); } catch (e) { console.error("link error:", (e as Error).message); }

  Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== "POST") return new Response("railrunner autoscaler ok\n");
      const body = await req.text();
      if (!verifySignature(secret, body, req.headers.get("x-hub-signature-256"))) {
        return new Response("bad signature", { status: 401 });
      }
      if (req.headers.get("x-github-event") === "workflow_job") {
        try {
          const { action, workflow_job: job } = JSON.parse(body) as {
            action: string;
            workflow_job: { id: number; labels: string[] };
          };
          if (jobMatches(job.labels ?? [], markers)) {
            if (action === "completed") jobs.delete(job.id);
            else if (action === "queued" || action === "in_progress") jobs.set(job.id, Date.now() + ttlMs);
            console.log(`${action} job ${job.id} -> active=${jobs.size}`);
            scheduleScale();
          }
        } catch (e) {
          console.error("payload error:", (e as Error).message);
        }
      }
      return new Response("ok"); // ack fast; scaling happens out of band
    },
  });

  const build = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "image";
  console.log(
    `railrunner autoscaler (webhook, link+scale, build=${build}): listening on :${port}, ` +
    `labels=[${markers.join(",")}], scaling ${serviceId} in ${region}, min=${min} max=${max}${dryRun ? " (DRY RUN)" : ""}`,
  );
  void applyScale(); // establish the MIN floor on boot
}

if (import.meta.main) await main();
