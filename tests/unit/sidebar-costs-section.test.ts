import test from "node:test";
import assert from "node:assert/strict";

const sidebarVisibility = await import("../../src/shared/constants/sidebarVisibility.ts");

function findSection(id: string) {
  return sidebarVisibility.SIDEBAR_SECTIONS.find((s) => s.id === id);
}

test("costs section exists in SIDEBAR_SECTIONS", () => {
  const section = findSection("costs");
  assert.ok(section, "costs section must exist");
});

/**
 * The costs section's composition, in display order. `radar`
 * (/dashboard/radar — the free-model catalog overlay, docs/frameworks/RADAR.md)
 * was added after this test was written, which is what broke it on main.
 * Deriving the length from this list keeps the two assertions from drifting
 * apart: deepEqual already pins the exact order and membership, so the count
 * only needs to agree with it, not be re-typed in a second place.
 */
const EXPECTED_COSTS_ITEMS = [
  { id: "costs", href: "/dashboard/costs" },
  { id: "costs-pricing", href: "/dashboard/costs/pricing" },
  { id: "costs-budget", href: "/dashboard/costs/budget" },
  { id: "costs-free-tiers", href: "/dashboard/free-tiers" },
  { id: "free-provider-rankings", href: "/dashboard/free-provider-rankings" },
  { id: "radar", href: "/dashboard/radar" },
];

test("costs section has exactly the expected items in the correct order", () => {
  const section = findSection("costs");
  assert.ok(section, "costs section must exist");

  const items = sidebarVisibility.getSectionItems(section);
  assert.equal(items.length, EXPECTED_COSTS_ITEMS.length, "costs section item count drifted");

  const itemIds = items.map((i) => i.id);
  assert.deepEqual(
    itemIds,
    EXPECTED_COSTS_ITEMS.map((i) => i.id)
  );
});

test("costs section items have correct hrefs", () => {
  const section = findSection("costs");
  assert.ok(section, "costs section must exist");

  const items = sidebarVisibility.getSectionItems(section);
  const hrefs = items.map((i) => ({ id: i.id, href: i.href }));

  assert.deepEqual(hrefs, EXPECTED_COSTS_ITEMS);
});

test("costs item uses costsOverview i18nKey (not costs)", () => {
  const section = findSection("costs");
  assert.ok(section, "costs section must exist");

  const costsItem = sidebarVisibility.getSectionItems(section).find((i) => i.id === "costs");
  assert.ok(costsItem, "costs item must exist in costs section");
  assert.equal(costsItem.i18nKey, "costsOverview");
  assert.equal(costsItem.subtitleKey, "costsOverviewSubtitle");
});

test("costs item was removed from analytics section", () => {
  const analyticsSection = findSection("analytics");
  assert.ok(analyticsSection, "analytics section must exist");

  const analyticsItems = sidebarVisibility.getSectionItems(analyticsSection);
  const analyticsItemIds = analyticsItems.map((i) => i.id);

  assert.equal(
    analyticsItemIds.includes("costs" as sidebarVisibility.HideableSidebarItemId),
    false,
    "costs item must not be in analytics section"
  );
});

test("costs section is positioned between analytics and monitoring", () => {
  const sectionIds = sidebarVisibility.SIDEBAR_SECTIONS.map((s) => s.id);
  const analyticsIdx = sectionIds.indexOf("analytics");
  const costsIdx = sectionIds.indexOf("costs");
  const monitoringIdx = sectionIds.indexOf("monitoring");

  assert.ok(analyticsIdx !== -1, "analytics section must exist");
  assert.ok(costsIdx !== -1, "costs section must exist");
  assert.ok(monitoringIdx !== -1, "monitoring section must exist");

  assert.ok(
    analyticsIdx < costsIdx,
    `analytics (${analyticsIdx}) must come before costs (${costsIdx})`
  );
  assert.ok(
    costsIdx < monitoringIdx,
    `costs (${costsIdx}) must come before monitoring (${monitoringIdx})`
  );
});

test("costs section titleKey is costsSection", () => {
  const section = findSection("costs");
  assert.ok(section, "costs section must exist");
  assert.equal(section.titleKey, "costsSection");
  assert.equal(section.titleFallback, "Costs");
});
