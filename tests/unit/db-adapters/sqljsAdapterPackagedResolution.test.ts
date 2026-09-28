// tests/unit/db-adapters/sqljsAdapterPackagedResolution.test.ts
// Regression guard for the packaged-CLI sql.js runtime contract.
//
// The packaged launcher boots the server with cwd set to <pkg>/dist, so neither
// <cwd>/node_modules/sql.js nor <cwd>/.next/standalone/node_modules/sql.js exists.
// sql.js is installed by npm at <pkg>/node_modules/sql.js. A resolver that only
// probes cwd-relative paths therefore throws
// "Packaged sql.js runtime is incomplete: sql-wasm.wasm was not found" and the
// published CLI answers HTTP 500 on /health.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { createSqlJsAdapter } = await import("../../../src/lib/db/adapters/sqljsAdapter.ts");

describe("sqljsAdapter — resolução do runtime sql.js no pacote instalado", () => {
  // Fixture dentro do próprio pacote: é o layout real do CLI publicado, em que
  // o launcher roda com cwd=<pkg>/… e o npm instala o sql.js em <pkg>/node_modules.
  const packageRoot = process.cwd();
  let originalCwd = "";
  let launcherCwd = "";

  before(() => {
    originalCwd = process.cwd();
    launcherCwd = fs.mkdtempSync(path.join(packageRoot, ".sqljs-launcher-cwd-"));
  });

  after(() => {
    process.chdir(originalCwd);
    fs.rmSync(launcherCwd, { recursive: true, force: true });
  });

  test("encontra sql-wasm.wasm mesmo quando cwd não é a raiz do pacote", async () => {
    process.chdir(launcherCwd);

    // Pré-condição: reproduz o layout que quebrava o CLI publicado — nenhum
    // sql.js relativo a cwd, mas ele existe um nível acima, como <pkg>/node_modules.
    assert.equal(
      fs.existsSync(path.join(launcherCwd, "node_modules", "sql.js", "dist", "sql-wasm.wasm")),
      false,
      "o probe relativo a cwd não pode encontrar o runtime — é esse o bug"
    );
    assert.equal(
      fs.existsSync(path.join(packageRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm")),
      true,
      "o runtime real existe um nível acima, como no pacote instalado"
    );

    const adapter = await createSqlJsAdapter(":memory:");

    // Prova que o WASM foi realmente carregado, não apenas localizado.
    const row = adapter.prepare("SELECT 1 AS ok").get() as { ok: number };
    assert.equal(row.ok, 1);

    adapter.close();
  });
});
