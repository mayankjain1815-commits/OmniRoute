#!/usr/bin/env node
/**
 * End-to-end proof for the `check:pack-boot` sql.js contract fix.
 *
 * The CI `Package Artifact` job failed with:
 *   "installed package is missing the sql.js runtime contract:
 *    dist/node_modules/sql.js/package.json, dist/node_modules/sql.js/dist/sql-wasm.js, ..."
 *
 * That assertion hardcoded a VENDORED sql.js path. But the published tarball ships no
 * nested node_modules on purpose:
 *   - package.json `files[]` carries a negation excluding every nested node_modules tree
 *   - PACK_ARTIFACT_NEVER_ALLOWED_SEGMENTS bans the `node_modules` segment outright
 *     (documented defence-in-depth against a 79 MB devDependency bloat under @omniroute/*)
 * and `sql.js` is a real `dependency`, so `npm install -g` installs it into the prefix and
 * the installed dist/server.js resolves it by walking up the node_modules chain.
 *
 * This harness reproduces the exact real-world flow — npm pack + `npm install -g` into a
 * clean prefix — against a package whose packaging contract matches the real one, then
 * asserts BOTH directions:
 *   1. the OLD vendored-path assertion fails (so the CI failure is genuinely reproduced), and
 *   2. the NEW resolution-based assertion passes (so the fix genuinely fixes it).
 *
 * Run: node scripts/ad-hoc/verify-pack-boot-sqljs-resolution.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_SQLJS_RUNTIME_FILES,
  resolveSqlJsPackageDir,
  findMissingSqlJsRuntimeFiles,
} from "../check/check-pack-boot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG_NAME = "omniroute-pack-boot-probe";

const work = mkdtempSync(path.join(tmpdir(), "pack-boot-sqljs-"));
const src = path.join(work, "src");

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  // ── A synthetic package whose packaging contract matches the real one ──────────────
  // `files` mirrors the real package.json: dist/ is shipped and a negation excludes
  // every nested node_modules tree. sql.js is a real dependency, exactly as upstream.
  mkdirSync(path.join(src, "dist"), { recursive: true });
  writeFileSync(
    path.join(src, "package.json"),
    JSON.stringify(
      {
        name: PKG_NAME,
        version: "1.0.0",
        files: ["dist/", "!**/node_modules/**"],
        dependencies: { "sql.js": "^1.14.2" },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(src, "dist", "server.js"),
    'const { createRequire } = require("node:module");\n' +
      "const req = createRequire(__filename);\n" +
      'const initSqlJs = req("sql.js");\n' +
      'if (typeof initSqlJs !== "function") { throw new Error("sql.js did not load"); }\n'
  );

  // ── The real flow: pack, then install into a clean prefix ─────────────────────────
  console.log("\n  npm pack …");
  sh("npm", ["pack", "--pack-destination", work], src);
  const tarball = path.join(work, `${PKG_NAME}-1.0.0.tgz`);

  console.log("  npm install -g into a clean prefix …");
  const prefix = path.join(work, "prefix");
  sh("npm", ["install", "-g", "--prefix", prefix, tarball], work);

  const packageRoot = path.join(prefix, "lib", "node_modules", PKG_NAME);

  // ── 1. Reproduce the CI failure with the OLD vendored-path contract ────────────────
  const vendoredDir = path.join(packageRoot, "dist", "node_modules", "sql.js");
  check(
    "tarball really does NOT ship a vendored dist/node_modules/sql.js (the CI precondition)",
    !existsSync(vendoredDir),
    "npm stripped it by design"
  );
  const oldMissing = [
    "dist/node_modules/sql.js/package.json",
    "dist/node_modules/sql.js/dist/sql-wasm.js",
    "dist/node_modules/sql.js/dist/sql-wasm.wasm",
  ].filter((rel) => !existsSync(path.join(packageRoot, rel)));
  check(
    "OLD vendored-path assertion FAILS on this healthy tarball (= the CI bug)",
    oldMissing.length === 3,
    `${oldMissing.length}/3 files reported missing`
  );

  // ── 2. The NEW resolution-based contract must pass ─────────────────────────────────
  const resolvedDir = resolveSqlJsPackageDir(packageRoot);
  check(
    "sql.js resolves from the installed dist/server.js",
    existsSync(path.join(resolvedDir, "package.json")),
    resolvedDir
  );
  check(
    "resolved dir is NOT inside dist/ (it comes from the install prefix)",
    !resolvedDir.startsWith(path.join(packageRoot, "dist")),
    "resolved via node_modules chain"
  );
  const newMissing = findMissingSqlJsRuntimeFiles(resolvedDir);
  check(
    "NEW assertion passes: sql.js WASM runtime contract is complete",
    newMissing.length === 0,
    newMissing.length
      ? `missing ${newMissing.join(", ")}`
      : `all ${REQUIRED_SQLJS_RUNTIME_FILES.length} required files present`
  );

  // ── 3. The resolved sql.js must actually LOAD (the contract is real, not nominal) ──
  const loadOut = sh(process.execPath, [path.join(packageRoot, "dist", "server.js")], packageRoot);
  check(
    "the installed dist/server.js actually resolves + loads sql.js",
    !loadOut.includes("did not load"),
    "no throw"
  );

  console.log(
    failures === 0
      ? "\n  OK — the resolution-based contract passes where the vendored one failed.\n"
      : `\n  ${failures} check(s) failed.\n`
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
