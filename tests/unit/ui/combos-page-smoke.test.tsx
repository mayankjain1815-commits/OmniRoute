// @vitest-environment jsdom
import { describe, it, expect } from "vitest";

// Timeout raised to 30000ms to handle the initial module transform overhead.
// The combos page pulls in the whole provider/combo surface, and the vitest UI
// job runs 198 test files in parallel, so this single dynamic import has to
// compete for the transform worker with every other file. In isolation it
// resolves in ~1.6s, but under that contention it regularly exceeded vitest's
// 5000ms default and failed with "Test timed out in 5000ms" — a scheduling
// artifact, not a broken export. Same convention as the sibling UI tests
// (agent-card.test.tsx, setup-wizard.test.tsx).
describe("combos page memoization", { timeout: 30000 }, () => {
  it("combos page module exports a default component", async () => {
    const mod = await import("@/app/(dashboard)/dashboard/combos/page");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });
});
