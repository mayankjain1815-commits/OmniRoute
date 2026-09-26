import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

test("Dockerfile's --ignore-scripts npm ci is compensated for tls-client-node's native binary, same as it is for wreq-js and better-sqlite3 (#7802)", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const postinstall = readFileSync(join(ROOT, "scripts/build/postinstall.mjs"), "utf8");

  // The install line may carry extra leading flags — `--include=optional` is
  // there on purpose, because the platform-native optionalDependencies this
  // test's whole premise depends on (tls-client-node's .so/.dylib/.dll,
  // better-sqlite3's binding) are skipped when npm omits optional deps. The
  // assertion that matters for #7802 is that the four hardening flags are
  // present and in order, so tolerate the leading flags rather than pinning the
  // exact command line.
  assert.match(
    dockerfile,
    /npm ci (?:\S+ )*--no-audit --no-fund --legacy-peer-deps --ignore-scripts/,
    "expected the builder stage to install with --ignore-scripts (precondition of #7802)"
  );

  // --include=optional must stay: without it `npm ci --ignore-scripts` drops the
  // native optional deps entirely and the compensating rebuild/postinstall steps
  // below have nothing to repair.
  assert.match(
    dockerfile,
    /npm ci --include=optional /,
    "expected npm ci to keep optionalDependencies (native platform binaries)"
  );

  assert.match(
    dockerfile,
    /better-sqlite3[\s\S]*node-gyp\.js rebuild/,
    "expected an explicit better-sqlite3 rebuild step after --ignore-scripts"
  );

  assert.match(
    postinstall,
    /fixWreqJsBinary/,
    "expected postinstall.mjs to repair wreq-js's native binary"
  );

  const dockerfileHandlesIt = /tls-client-node[\s\S]{0,200}(postinstall|rebuild|download)/i.test(
    dockerfile
  );
  const postinstallHandlesIt = /tls-client-node/i.test(postinstall);

  assert.ok(
    dockerfileHandlesIt || postinstallHandlesIt,
    "tls-client-node has no --ignore-scripts compensation in Dockerfile or " +
      "scripts/build/postinstall.mjs (unlike better-sqlite3 and wreq-js) — " +
      "node_modules/tls-client-node/bin/ is never populated in the official " +
      "Docker image, so chatgpt-web/claude-web/grok-web/lmarena/perplexity-web " +
      "all fail with TlsClientUnavailableError at first request (#7802)"
  );
});
