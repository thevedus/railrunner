import { test, expect } from "bun:test";
import { desiredReplicas, verifySignature, jobMatches } from "./autoscale";

test("clamps demand into [min, max]", () => {
  expect(desiredReplicas(0, 1, 5)).toBe(1); // idle -> floor
  expect(desiredReplicas(3, 1, 5)).toBe(3); // within range -> passthrough
  expect(desiredReplicas(9, 1, 5)).toBe(5); // burst -> ceiling
  expect(desiredReplicas(0, 0, 5)).toBe(0); // scale-to-zero when idle
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
