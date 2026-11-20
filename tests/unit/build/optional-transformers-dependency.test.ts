import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

function readJson<T = Record<string, unknown>>(relPath: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as T;
}

test("@huggingface/transformers is optional so onnxruntime CUDA install failures cannot abort OmniRoute install", () => {
  const pkg = readJson<{
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>("package.json");

  assert.equal(
    pkg.dependencies?.["@huggingface/transformers"],
    undefined,
    "transformers must not be a regular dependency because it pulls onnxruntime-node install scripts"
  );
  assert.equal(pkg.optionalDependencies?.["@huggingface/transformers"], "3.5.2");
});

test("package-lock marks transformers and its onnxruntime runtime as optional", () => {
  const lock = readJson<{
    packages: Record<string, { optional?: boolean; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
  }>("package-lock.json");

  assert.equal(
    lock.packages[""]?.dependencies?.["@huggingface/transformers"],
    undefined,
    "root lock dependencies must not keep transformers as mandatory"
  );
  assert.equal(lock.packages[""]?.optionalDependencies?.["@huggingface/transformers"], "3.5.2");

  for (const packagePath of [
    "node_modules/@huggingface/transformers",
    "node_modules/onnxruntime-node",
    "node_modules/onnxruntime-common",
  ]) {
    assert.equal(lock.packages[packagePath]?.optional, true, `${packagePath} should be optional`);
  }
});

test("production source never uses a build-time-resolved import of the optional dep", () => {
  // A literal dynamic import is still resolved statically by tsc and webpack.
  // When CI installs without optional deps that produces TS2307 and a webpack
  // "Module not found", breaking typecheck and the Node 24/26 build matrix.
  const literalImport = /(?:\bimport\s*\(|\bfrom\s*)["']@huggingface\/transformers["']/;
  const sourceExt = /\.(?:ts|tsx|mts|cts)$/;
  const offenders: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "tests") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        sourceExt.test(entry.name) &&
        literalImport.test(readFileSync(full, "utf8"))
      ) {
        offenders.push(full);
      }
    }
  }

  // These trees hold every production module that reaches the Next build.
  for (const root of ["src", "open-sse"]) walk(join(repoRoot, root));

  assert.deepEqual(
    offenders,
    [],
    `optional dep must be loaded through a runtime-variable import, found literal import in: ${offenders.join(", ")}`
  );
});
