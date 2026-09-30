import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Plugin SDK public surface — regression guard for the dead-code cleanup.
 *
 * `src/lib/plugins/sdk.ts` is a PUBLIC API: it is the typed entry point that
 * external plugin authors import (see `docs/frameworks/PLUGIN_SDK.md`). It has
 * no in-repo importer, because the consumers live outside this repository.
 *
 * The dead-code wave removed the `@/lib/plugins` barrel re-exports that used to
 * be the only in-repo reference to this module, which left `sdk.ts` reported as
 * a dead *file* by knip. Rather than delete a documented public API, it is now
 * declared as a knip `entry` so the tool models the external-consumer boundary.
 *
 * That declaration has a sharp edge: once `sdk.ts` is an entry, knip stops
 * reporting it entirely. A future cleanup can therefore delete the SDK — or drop
 * the entry declaration — and the dead-code gate will stay green either way.
 * These tests are the tripwire for that.
 */

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SDK_PATH = path.join(ROOT, "src/lib/plugins/sdk.ts");
const KNIP_PATH = path.join(ROOT, "knip.json");
const SDK_DOC = path.join(ROOT, "docs/frameworks/PLUGIN_SDK.md");

/** The exports `PLUGIN_SDK.md` documents as the plugin-authoring surface. */
const PUBLIC_SDK_EXPORTS = ["definePlugin", "blockRequest", "modifyBody", "addMetadata"];

test("plugin SDK module exists — it is a documented public API, not dead code", () => {
  assert.ok(
    fs.existsSync(SDK_PATH),
    "src/lib/plugins/sdk.ts was deleted. It is the public plugin-authoring API " +
      "documented in docs/frameworks/PLUGIN_SDK.md; its consumers are external " +
      "plugins, so knip cannot see them. Do not remove it as dead code."
  );
});

test("plugin SDK still exports its documented authoring surface", () => {
  const src = fs.readFileSync(SDK_PATH, "utf8");
  for (const name of PUBLIC_SDK_EXPORTS) {
    assert.match(
      src,
      new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class|type|interface)\\s+${name}\\b`),
      `src/lib/plugins/sdk.ts no longer exports \`${name}\`, which PLUGIN_SDK.md ` +
        "documents as part of the plugin-authoring API."
    );
  }
});

test("knip declares the plugin SDK as an entry, so the public API is not counted dead", () => {
  const knip = JSON.parse(fs.readFileSync(KNIP_PATH, "utf8"));
  const entries: string[] = knip.workspaces?.["."]?.entry ?? [];
  assert.ok(
    entries.includes("src/lib/plugins/sdk.ts"),
    "knip.json must list src/lib/plugins/sdk.ts as an entry. Without it knip " +
      "reports the documented public plugin SDK as a dead file, and the only " +
      "apparent 'fix' is to delete a public API."
  );
});

test("the SDK entry declaration points at documentation that still exists", () => {
  // Guards the justification itself: the entry exists because PLUGIN_SDK.md
  // documents an external-consumer surface. If that doc is removed, the
  // justification is void and the declaration should be revisited.
  assert.ok(
    fs.existsSync(SDK_DOC),
    "docs/frameworks/PLUGIN_SDK.md is missing. The knip entry for " +
      "src/lib/plugins/sdk.ts is justified by that document — revisit whether " +
      "the module is still a public API."
  );
});

test("the deprecated plugins barrel no longer re-exports the SDK surface", () => {
  // The barrel is marked @deprecated in favour of importing ./sdk.ts directly.
  // These assertions pin the cleanup so the removed re-exports cannot silently
  // return and re-inflate the dead-code baseline.
  const barrelPath = path.join(ROOT, "src/lib/plugins/index.ts");
  const barrel = fs.readFileSync(barrelPath, "utf8");
  for (const name of PUBLIC_SDK_EXPORTS) {
    assert.doesNotMatch(
      barrel,
      new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']\\./sdk\\.ts["']`),
      `src/lib/plugins/index.ts re-exports \`${name}\` from ./sdk.ts again. That ` +
        "re-export is dead (nothing imports it) and was removed in the dead-code cleanup."
    );
  }
});
