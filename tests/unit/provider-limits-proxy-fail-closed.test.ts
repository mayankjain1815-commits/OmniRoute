import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-limits-proxy-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-provider-limits-proxy-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");
const { resolveProxyForRequest } = await import("../../open-sse/utils/proxyFetch.ts");

const originalFetch = globalThis.fetch;

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

/**
 * A proxy-aware stand-in for `globalThis.fetch`.
 *
 * `open-sse/utils/proxyFetch.ts` installs `patchedFetch` as `globalThis.fetch` at
 * module load, and THAT wrapper is what reads the ambient proxy context and attaches
 * the proxy dispatcher. Overwriting `globalThis.fetch` therefore removes the proxy
 * decision from the picture entirely: the mock answers for the proxied attempt and
 * the direct retry alike, so a test built that way cannot tell "egressed through the
 * pinned proxy" from "fell back to direct" — and, worse, a mock that always returns
 * a healthy 200 makes the proxied attempt *look* like it succeeded, so the fail-closed
 * path is never reached.
 *
 * This harness instead asks the same exported resolver `patchedFetch` itself calls
 * (`resolveProxyForRequest`, which reads the same AsyncLocalStorage store) and
 * emulates the transport outcome for whichever egress path production chose:
 *
 *   - OmniRoute-assigned proxy in context → emulate an unreachable proxy
 *     (`TypeError: fetch failed` with `cause.code = ECONNREFUSED`, the exact shape
 *     `providerLimits` classifies on).
 *   - otherwise                          → direct egress: record the URL and let
 *     the test's own response stand in for the upstream.
 *
 * `onProxied` overrides which proxied calls fail. It exists because a provider's
 * OAuth token refresh runs *inside* the same proxy context, ahead of the usage
 * fetch that is actually under test. Letting every proxied call fail means the
 * refresh dies first and the rejection the test observes comes from the refresh,
 * not from the fail-closed decision — the test would then pass even if that
 * decision were reverted. Tests that need to get past a refresh use this hook to
 * let the bootstrap succeed and fail only the usage endpoint.
 *
 * Env-var proxies (`HTTP_PROXY` etc.) are neutralised in `beforeEach` so that
 * `source === "context"` is the only thing that can select the proxied path — otherwise
 * a proxy configured in the CI runner would silently change what these tests prove.
 */
function withProxyAwareFetch(opts: {
  directFetchUrls: string[];
  onDirect: (url: string) => Response | Promise<Response>;
  onProxied?: (url: string) => Response | Promise<Response>;
}) {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = (async (url: URL | RequestInfo) => {
    const urlText = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const { source } = resolveProxyForRequest(urlText);

    if (source === "context") {
      if (opts.onProxied) return opts.onProxied(urlText);
      const err = new TypeError("fetch failed") as TypeError & {
        cause: { code: string; syscall: string };
      };
      err.cause = { code: "ECONNREFUSED", syscall: "connect" };
      throw err;
    }

    opts.directFetchUrls.push(urlText);
    return opts.onDirect(urlText);
  }) as typeof fetch;

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      globalThis.fetch = previousFetch;
    }
  };
}

async function createClaudeOAuthConnection() {
  return providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: `Claude Provider Limits ${Date.now()} ${Math.random()}`,
    email: `claude-${Date.now()}-${Math.random()}@example.test`,
    accessToken: "claude-access-token",
    refreshToken: "claude-refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

function claudeUsageResponse() {
  return new Response(
    JSON.stringify({
      tier: "pro",
      five_hour: {
        utilization: 25,
        resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      seven_day: {
        utilization: 50,
        resets_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function claudeBootstrapResponse() {
  return new Response(
    JSON.stringify({
      oauth_account: {
        account_uuid: "account-uuid-test",
        account_email: "claude@example.test",
        organization_uuid: "org-uuid-test",
        organization_name: "Test Org",
        organization_type: "pro",
        organization_rate_limit_tier: "pro",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// Env-var proxies would otherwise let `resolveProxyForRequest` report
// `source: "env"` for the direct-retry phase and make these tests depend on the
// runner's environment. See withProxyAwareFetch's doc comment.
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];
const savedProxyEnv = new Map<string, string | undefined>();

test.beforeEach(async () => {
  for (const key of PROXY_ENV_KEYS) {
    savedProxyEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  globalThis.fetch = originalFetch;
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedProxyEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("Claude provider limits fail closed when an account proxy is unreachable", async () => {
  const connection = await createClaudeOAuthConnection();
  const connectionId = (connection as any).id;
  const directFetchUrls: string[] = [];

  await settingsDb.setProxyForLevel("key", connectionId, {
    type: "http",
    host: "127.0.0.1",
    port: 1,
  });

  const run = withProxyAwareFetch({
    directFetchUrls,
    onDirect: () => claudeUsageResponse(),
  });

  await assert.rejects(
    () => run(() => providerLimits.fetchAndPersistProviderLimits(connectionId, "manual")),
    /Proxy unreachable|fetch failed|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT/i
  );

  assert.deepEqual(directFetchUrls, [], "account-proxied Claude usage must not retry direct");
});

test("non-Claude OAuth provider limits fail closed when an account proxy is unreachable", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "github",
    authType: "oauth",
    name: `GitHub Provider Limits ${Date.now()} ${Math.random()}`,
    email: `github-${Date.now()}-${Math.random()}@example.test`,
    accessToken: "github-access-token",
    refreshToken: "github-refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const connectionId = (connection as any).id;
  const directFetchUrls: string[] = [];

  await settingsDb.setProxyForLevel("key", connectionId, {
    type: "http",
    host: "127.0.0.1",
    port: 1,
  });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  // The GitHub OAuth path mints a fresh Copilot token and a fresh GitHub access
  // token before it ever fetches usage, and both calls run inside the same proxy
  // context. Let that bootstrap succeed so the flow reaches the USAGE fetch
  // (copilot_internal/user) — the call whose proxy failure must fail closed. If the
  // bootstrap were failed instead, the rejection would come from the token
  // manager's wrapped error, which is classified as a non-network failure and
  // rethrown regardless of the fail-closed setting, leaving the assertion below
  // unable to distinguish fail-closed from fail-open.
  const run = withProxyAwareFetch({
    directFetchUrls,
    onProxied: (url) => {
      if (url.includes("/copilot_internal/v2/token")) {
        return json({
          token: "copilot-token",
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
      }
      if (url.includes("/login/oauth/access_token")) {
        return json({
          access_token: "github-access-token-2",
          refresh_token: "github-refresh-token-2",
          token_type: "bearer",
          expires_in: 28800,
        });
      }
      // The usage endpoint: fail with a refused connect so the fail-closed
      // decision is the one under test.
      const err = new TypeError("fetch failed") as TypeError & {
        cause: { code: string; syscall: string };
      };
      err.cause = { code: "ECONNREFUSED", syscall: "connect" };
      throw err;
    },
    onDirect: () =>
      json({
        copilot_plan: "free",
        monthly_quotas: { chat: 500 },
        limited_user_quotas: { chat: 500 },
      }),
  });

  await assert.rejects(
    () => run(() => providerLimits.fetchAndPersistProviderLimits(connectionId, "manual")),
    /Proxy unreachable|fetch failed|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT/i
  );

  assert.deepEqual(directFetchUrls, [], "account-proxied OAuth usage must not retry direct");
});

test("Claude provider limits preserve direct retry for non-account proxy failures", async () => {
  const connection = await createClaudeOAuthConnection();
  const connectionId = (connection as any).id;
  const directFetchUrls: string[] = [];

  await settingsDb.setProxyForLevel("provider", "claude", {
    type: "http",
    host: "127.0.0.1",
    port: 1,
  });

  const run = withProxyAwareFetch({
    directFetchUrls,
    onDirect: (url) => {
      if (url.includes("/api/claude_cli/bootstrap")) return claudeBootstrapResponse();
      if (url.includes("/api/oauth/usage")) return claudeUsageResponse();
      throw new Error(`Unexpected direct fetch: ${url}`);
    },
  });

  const result = await run(() =>
    providerLimits.fetchAndPersistProviderLimits(connectionId, "manual")
  );

  assert.equal(result.connection.id, connectionId);
  assert.ok(result.usage.quotas);
  assert.equal(result.cache.source, "manual");

  // The proxy attempt really did go through the pinned proxy this time — the
  // proxy-aware mock answers it with a refused connect, which is what drives the
  // retry asserted here. Under the old plain-`globalThis.fetch`-mock harness the
  // "proxied" attempt was also intercepted and answered 200, so this retry was
  // never actually exercised.
  assert.equal(
    directFetchUrls.some((url) => url.includes("/api/oauth/usage")),
    true,
    "provider-level proxy failures should retain the existing direct retry behavior"
  );
});
