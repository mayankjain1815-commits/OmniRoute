/**
 * Regression guard: the /api/cloud/* route family must stay tracked by git.
 *
 * Root cause this locks down: `.gitignore` carried a bare `cloud/` pattern
 * (meant for the top-level Playwright output dir) which git matches at ANY depth.
 * That silently untracked the whole `src/app/api/cloud/` subtree, so the routes
 * never reached a commit — while `src/shared/constants/publicApiRoutes.ts`
 * (PUBLIC_CLOUD_API_ROUTES), the docs, the openapi area map and
 * tests/integration/security-hardening.test.ts all still referenced them. The
 * visible symptom was three unrelated-looking red gates: `check:fabricated-docs`
 * reporting 6 phantom endpoints, the T06 integration test failing to find
 * 4 route files, and `tests/unit/cloud-write-auth.test.ts` failing to import.
 *
 * The class of bug is a `.gitignore` pattern whose scope is wider than intended,
 * so the assertions below are deliberately general rather than a fixed file list:
 *   1. no file under src/app/api/ may be ignored by git, and
 *   2. every path the authz allowlist advertises as public must exist on disk.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

const hasGit = (() => {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
})();

test("no route file under src/app/api/ is hidden by .gitignore", { skip: !hasGit }, () => {
  // Untracked AND ignored files under the API route tree. `git ls-files` cannot
  // see these at all, which is exactly how the cloud routes went missing.
  const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--", "src/app/api"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  assert.deepEqual(
    ignored,
    [],
    `these API route files are ignored by .gitignore and would never be committed:\n${ignored.join("\n")}\n` +
      "A bare directory pattern (e.g. `cloud/`) matches at ANY depth — anchor such " +
      "patterns to the repo root (`/cloud/`) so they cannot swallow src/app/ subtrees."
  );
});

test("no source directory under src/ is shadowed by a bare .gitignore directory pattern", () => {
  const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");

  // Bare trailing-slash patterns match at ANY depth. A leading `/` anchors them.
  const barePatterns = new Set(
    gitignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z0-9._-]+\/$/.test(line))
      .map((line) => line.slice(0, -1))
  );

  const shadowed: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const relative = path.relative(REPO_ROOT, full);
      if (barePatterns.has(entry.name)) shadowed.push(relative);
      walk(full, depth + 1);
    }
  };

  for (const root of ["src", "open-sse", "tests", "scripts", "electron", "bin"]) {
    const full = path.join(REPO_ROOT, root);
    if (existsSync(full)) walk(full, 0);
  }

  assert.deepEqual(
    shadowed,
    [],
    "these source directories share a name with a bare trailing-slash .gitignore pattern, " +
      "so git ignores them at any depth and they can never be committed:\n" +
      shadowed.join("\n") +
      "\nAnchor the pattern with a leading `/` (e.g. `coverage/` -> `/coverage/`)."
  );
});

test("every path advertised as public by publicApiRoutes.ts exists on disk", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "src/shared/constants/publicApiRoutes.ts"),
    "utf8"
  );

  // PUBLIC_CLOUD_API_ROUTES entries look like { path: "/api/cloud/auth", ... }.
  const advertised = [...source.matchAll(/path:\s*"((\/api\/[^"]+))"/g)].map((match) => match[1]);
  assert.ok(advertised.length >= 3, `expected the cloud allowlist to advertise routes, got ${advertised.length}`);

  const missing = advertised.filter((routePath) => {
    const routeFile = path.join(REPO_ROOT, "src/app", routePath.replace(/^\//, ""), "route.ts");
    return !existsSync(routeFile);
  });

  assert.deepEqual(
    missing,
    [],
    `publicApiRoutes.ts advertises routes that do not exist:\n${missing.join("\n")}`
  );
});

test("the .gitignore cloud/ pattern is anchored to the repo root", () => {
  const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  const cloudPatterns = gitignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.replace(/^\/|\/$/g, "") === "cloud" && line.endsWith("/"));

  assert.deepEqual(
    cloudPatterns,
    ["/cloud/"],
    "a bare `cloud/` in .gitignore matches at ANY depth and silently untracked " +
      "src/app/api/cloud/ — it must stay anchored to the repo root"
  );
});
