import { test, expect } from "bun:test";
import { targetReplicas, verifySignature, jobMatches } from "./autoscale";

test("targetReplicas scales up to demand but only down when idle", () => {
  expect(targetReplicas(2, 0, 0, 5)).toBe(2); // demand 2 -> up to 2
  expect(targetReplicas(1, 2, 0, 5)).toBe(2); // one job finished -> hold at 2 (don't kill the busy one)
  expect(targetReplicas(0, 2, 0, 5)).toBe(0); // all idle -> drop to floor
  expect(targetReplicas(9, 2, 0, 5)).toBe(5); // burst capped at max
  expect(targetReplicas(0, 3, 1, 5)).toBe(1); // idle with floor 1
});

test("verifySignature matches GitHub's documented HMAC example", () => {
  // GitHub docs test vector: secret / body / signature.
  const sig = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  expect(verifySignature("It's a Secret to Everybody", "Hello, World!", sig)).toBe(true);
  expect(verifySignature("wrong secret", "Hello, World!", sig)).toBe(false);
  expect(verifySignature("It's a Secret to Everybody", "Hello, World!", null)).toBe(false);
});

test("jobMatches requires all marker labels", () => {
  expect(jobMatches(["self-hosted", "railrunner"], ["railrunner"])).toBe(true);
  expect(jobMatches(["self-hosted", "railrunner"], ["self-hosted", "railrunner"])).toBe(true);
  expect(jobMatches(["self-hosted"], ["railrunner"])).toBe(false);
  expect(jobMatches([], ["railrunner"])).toBe(false);
});
