// @vitest-environment jsdom
import { describe, it, expect } from "vitest";

// Timeout raised to 30000ms to handle the initial module transform overhead.
// EvalsTab pulls in the whole evals/usage surface, and the vitest UI job runs
// 198 test files in parallel, so this single dynamic import has to compete for
// the transform worker with every other file. Under that contention it
// exceeded vitest's 5000ms default and failed with "Test timed out in 5000ms"
// — a scheduling artifact, not a broken export. Identical rationale and
// convention to its sibling combos-page-smoke.test.tsx.
describe("EvalsTab memoization", { timeout: 30000 }, () => {
  it("EvalsTab page module exports a default component", async () => {
    const mod = await import("@/app/(dashboard)/dashboard/usage/components/EvalsTab");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });
});
