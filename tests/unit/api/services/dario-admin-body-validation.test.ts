/**
 * Body-validation regression tests for the Dario admin proxy routes.
 *
 * `check:route-validation:t06` (scripts/check/check-route-validation.mjs) fails
 * any route that calls `request.json()` without a Zod `validateBody()` /
 * `.safeParse()`. Three Dario routes were hand-rolling the parse:
 *
 *   - src/app/api/services/dario/admin/accounts/route.ts
 *   - src/app/api/services/dario/admin/import-from-omniroute/route.ts
 *   - src/app/api/services/dario/admin/login-start/route.ts
 *
 * These tests pin the *validated* behaviour so the gate cannot regress back to
 * ad-hoc casts: malformed JSON and wrong-typed fields must be rejected with 400
 * before any forward to the running Dario instance is attempted.
 *
 * The forward target (Dario on loopback) is never reachable from a unit test, so
 * a request that survives validation ends in `forwardToDarioAdmin()` returning
 * 409 "Dario admin token unavailable" (no seeded version_manager row). That 409
 * is the proof the body passed validation; a 400 means it did not.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dario-admin-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
// `requireAdminAuth` is a no-op when auth is not required, which keeps these
// tests focused on body validation rather than on the auth tier.
process.env.REQUIRE_API_KEY = "false";

const core = await import("../../../../src/lib/db/core.ts");
// Force DB bootstrap/migrations so imports that touch the DB layer resolve.
core.getDbInstance();

const accountsRoute = await import(
  "../../../../src/app/api/services/dario/admin/accounts/route.ts"
);
const importRoute = await import(
  "../../../../src/app/api/services/dario/admin/import-from-omniroute/route.ts"
);
const loginStartRoute = await import(
  "../../../../src/app/api/services/dario/admin/login-start/route.ts"
);

function jsonRequest(url: string, body: string, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function errorMessage(res: Response): Promise<string> {
  const payload = (await res.json()) as { error?: { message?: string } };
  return String(payload?.error?.message ?? "");
}

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("DELETE /api/services/dario/admin/accounts body validation", () => {
  it("rejects a body that is not valid JSON with 400", async () => {
    const res = await accountsRoute.DELETE(
      jsonRequest("http://localhost/api/services/dario/admin/accounts", "{not json", "DELETE")
    );
    assert.equal(res.status, 400);
    assert.match(await errorMessage(res), /alias required/);
  });

  it("rejects a non-string alias instead of forwarding a coerced value", async () => {
    const res = await accountsRoute.DELETE(
      jsonRequest(
        "http://localhost/api/services/dario/admin/accounts",
        JSON.stringify({ alias: 42 }),
        "DELETE"
      )
    );
    assert.equal(res.status, 400);
    assert.match(await errorMessage(res), /alias required/);
  });

  it("rejects an empty string alias", async () => {
    const res = await accountsRoute.DELETE(
      jsonRequest(
        "http://localhost/api/services/dario/admin/accounts",
        JSON.stringify({ alias: "   " }),
        "DELETE"
      )
    );
    assert.equal(res.status, 400);
    assert.match(await errorMessage(res), /alias required/);
  });

  it("accepts a valid body alias and proceeds past validation (409 = no Dario token)", async () => {
    const res = await accountsRoute.DELETE(
      jsonRequest(
        "http://localhost/api/services/dario/admin/accounts",
        JSON.stringify({ alias: "work" }),
        "DELETE"
      )
    );
    assert.equal(res.status, 409, "a valid alias must reach forwardToDarioAdmin");
  });

  it("still honours the ?alias= query param without a body", async () => {
    const res = await accountsRoute.DELETE(
      new Request("http://localhost/api/services/dario/admin/accounts?alias=query-alias", {
        method: "DELETE",
      })
    );
    assert.equal(res.status, 409);
  });
});

describe("POST /api/services/dario/admin/import-from-omniroute body validation", () => {
  it("rejects malformed JSON with 400", async () => {
    const res = await importRoute.POST(
      jsonRequest(
        "http://localhost/api/services/dario/admin/import-from-omniroute",
        "{oops"
      )
    );
    assert.equal(res.status, 400);
    assert.match(await errorMessage(res), /Invalid JSON body/);
  });

  it("rejects a missing connectionId with 400", async () => {
    const res = await importRoute.POST(
      jsonRequest(
        "http://localhost/api/services/dario/admin/import-from-omniroute",
        JSON.stringify({})
      )
    );
    assert.equal(res.status, 400);
    assert.match(await errorMessage(res), /connectionId is required/);
  });

  it("rejects a non-string connectionId with 400", async () => {
    const res = await importRoute.POST(
      jsonRequest(
        "http://localhost/api/services/dario/admin/import-from-omniroute",
        JSON.stringify({ connectionId: { id: "abc" } })
      )
    );
    assert.equal(res.status, 400);
    assert.match(await errorMessage(res), /connectionId is required/);
  });

  it("rejects a non-string alias with 400 rather than silently ignoring it", async () => {
    const res = await importRoute.POST(
      jsonRequest(
        "http://localhost/api/services/dario/admin/import-from-omniroute",
        JSON.stringify({ connectionId: "conn-1", alias: 7 })
      )
    );
    assert.equal(res.status, 400);
    assert.match(await errorMessage(res), /connectionId is required/);
  });
});

describe("POST /api/services/dario/admin/login-start body validation", () => {
  it("rejects malformed JSON with 400", async () => {
    const res = await loginStartRoute.POST(
      jsonRequest("http://localhost/api/services/dario/admin/login-start", "{nope")
    );
    assert.equal(res.status, 400);
    assert.match(await errorMessage(res), /Invalid JSON body/);
  });

  it("rejects a non-string alias with 400", async () => {
    const res = await loginStartRoute.POST(
      jsonRequest(
        "http://localhost/api/services/dario/admin/login-start",
        JSON.stringify({ alias: ["work"] })
      )
    );
    assert.equal(res.status, 400);
  });

  it("rejects an over-long alias with 400", async () => {
    const res = await loginStartRoute.POST(
      jsonRequest(
        "http://localhost/api/services/dario/admin/login-start",
        JSON.stringify({ alias: "x".repeat(201) })
      )
    );
    assert.equal(res.status, 400);
  });

  it("accepts a valid alias and proceeds past validation (409 = no Dario token)", async () => {
    const res = await loginStartRoute.POST(
      jsonRequest(
        "http://localhost/api/services/dario/admin/login-start",
        JSON.stringify({ alias: "work" })
      )
    );
    assert.equal(res.status, 409);
  });

  it("accepts an empty JSON object and proceeds past validation", async () => {
    const res = await loginStartRoute.POST(
      jsonRequest("http://localhost/api/services/dario/admin/login-start", "{}")
    );
    assert.equal(res.status, 409);
  });
});
