/**
 * Guards the exact regression that made `npm run test:vitest` unstartable on
 * `main`: `vitest@5` and `@vitejs/plugin-react@6` both declare a REQUIRED peer
 * dependency on `vite`, but package.json never declared it — it only appeared in
 * `overrides`, which npm ignores for packages absent from the tree. `npm ci`
 * therefore installed no `vite` and vitest died at startup with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'vite'`, taking all 35 test files
 * with it.
 *
 * A missing peer is invisible to `check:deps` (which validates the anti-slopsquat
 * allowlist, not peer completeness) and to the type checker, so it is only caught
 * at runtime, by a runner that cannot boot.
 *
 * The assertion is PRESENCE, not version satisfaction: it verifies every
 * non-optional peer of a direct dependency is either declared in the root manifest
 * or resolvable in the installed tree. Version ranges are npm's responsibility at
 * install time, and a wrong range surfaces as a different, more obvious error.
 *
 * This test deliberately does NOT import `semver` — reaching for an undeclared
 * transitive package here would recreate the very bug it guards against.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/**
 * Pre-existing gaps unrelated to the test/build runners. Each is a peer that
 * npm leaves unsatisfied but that does not break any runner: they back optional
 * UI surfaces rather than vitest/webpack tooling. Listed explicitly (rather than
 * skipped wholesale) so the set is auditable and any new entry is a deliberate
 * decision. Remove an entry once the underlying peer is declared.
 */
const KNOWN_UNSATISFIED_PEERS: Record<string, string> = {
  "@lobehub/ui":
    "peer of @lobehub/icons (icon set rendered in the dashboard; icons degrade gracefully)",
  antd: "peer of @lobehub/icons (only needed for the Ant Design icon theme, not used)",
  "@testing-library/dom":
    "peer of @testing-library/react + @testing-library/jest-dom (assertions run via vitest's expect)",
  webpack: "peer of node-loader (webpack is not part of any configured toolchain)",
};

function installedVersion(name: string): string | null {
  const manifestPath = path.join(REPO_ROOT, "node_modules", name, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return (JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

test("every required peer dependency of a direct dependency is resolvable", () => {
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };
  const directNames = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);

  const unsatisfied: string[] = [];

  for (const name of directNames) {
    const version = installedVersion(name);
    // A direct dep that is not installed at all (e.g. an optional platform
    // binary) has no peers to validate here; npm's install step covers it.
    if (!version) continue;

    const depManifestPath = path.join(REPO_ROOT, "node_modules", name, "package.json");
    const depManifest = JSON.parse(readFileSync(depManifestPath, "utf8")) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    for (const [peer, range] of Object.entries(depManifest.peerDependencies ?? {})) {
      // Optional peers are explicitly allowed to be absent.
      if (depManifest.peerDependenciesMeta?.[peer]?.optional) continue;
      if (peer in KNOWN_UNSATISFIED_PEERS) continue;
      if (peer in declared || installedVersion(peer)) continue;

      unsatisfied.push(`${name}@${version} requires peer ${peer}@${range}`);
    }
  }

  assert.deepEqual(
    unsatisfied,
    [],
    "required peer dependencies are not declared in package.json and not installed.\n" +
      "npm ignores `overrides` for packages missing from the tree, so a pin there " +
      "is not enough — the package must also be a real dependency. A missing peer " +
      "makes the dependent module fail to load at runtime, not at type-check time.\n" +
      unsatisfied.join("\n")
  );
});

test("the vite peer required by vitest and @vitejs/plugin-react is declared", () => {
  // Narrow, explicit guard on the specific dependency that broke test:vitest,
  // so the failure names the culprit instead of appearing as an opaque
  // ERR_MODULE_NOT_FOUND from inside vitest's own chunk.
  const declared =
    manifest.devDependencies?.vite ??
    manifest.dependencies?.vite ??
    manifest.optionalDependencies?.vite;

  assert.ok(
    declared,
    "package.json must declare vite: both vitest@5 and @vitejs/plugin-react@6 " +
      "list it as a REQUIRED peer dependency, so npm ci installs nothing without it " +
      "and `npm run test:vitest` cannot start."
  );
});
