/**
 * Reproduce the E2E failure: GET /api/v1/models returned non-2xx in
 * E2E Tests (3/9), failing `expect(res.ok()).toBeTruthy()` on all 3 attempts
 * with no server-side log line.
 *
 * Calls the route's GET handler directly with a bare Request, in the same env
 * the E2E job uses, and prints the status + body so the failure mode is visible
 * rather than inferred.
 *
 * Usage: node --import tsx/esm scripts/ad-hoc/repro-models-route.mjs
 */
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.JWT_SECRET = "ci-test-secret-with-sufficient-length-for-validation";
process.env.API_KEY_SECRET = "ci-test-api-key-secret-long";

const { GET } = await import("../../src/app/api/v1/models/route.ts");

const req = new Request("http://localhost:20128/api/v1/models", {
  method: "GET",
  headers: { accept: "application/json" },
});

try {
  const res = await GET(req);
  const text = await res.text();
  console.log(`  status : ${res.status} ${res.statusText}`);
  console.log(`  ok     : ${res.ok}`);
  console.log(`  ctype  : ${res.headers.get("content-type")}`);
  console.log(`  body   : ${text.slice(0, 400)}`);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (parsed) {
    console.log(`  keys   : ${Object.keys(parsed).join(", ")}`);
    console.log(`  data is array: ${Array.isArray(parsed.data)}`);
  }
} catch (err) {
  console.log(
    `  THREW  : ${err && err.stack ? err.stack.split("\n").slice(0, 6).join("\n         ") : err}`
  );
  process.exitCode = 1;
}
