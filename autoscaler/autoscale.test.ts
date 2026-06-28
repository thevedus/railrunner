import { test, expect } from "bun:test";
import { desiredReplicas, normalizeRepo } from "./autoscale";

test("clamps demand into [min, max]", () => {
  expect(desiredReplicas(0, 1, 5)).toBe(1); // idle -> floor
  expect(desiredReplicas(3, 1, 5)).toBe(3); // within range -> passthrough
  expect(desiredReplicas(9, 1, 5)).toBe(5); // burst -> ceiling
  expect(desiredReplicas(0, 0, 5)).toBe(0); // scale-to-zero when idle
});

test("normalizeRepo accepts URLs and slugs", () => {
  expect(normalizeRepo("https://github.com/acme/api")).toBe("acme/api");
  expect(normalizeRepo("  acme/web/  ")).toBe("acme/web");
  expect(normalizeRepo("https://github.com/acme/api.git")).toBe("acme/api");
  expect(normalizeRepo("acme/api")).toBe("acme/api");
});
