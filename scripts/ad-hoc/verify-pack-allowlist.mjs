/**
 * Validate the check:pack-artifact fix for the real CI failure:
 *   "❌ Unexpected files were found in the npm publish artifact:
 *      - scripts/build/fixPlaywrightAndroid.mjs"
 *
 * Runs the same policy functions the CI check uses, over a synthetic artifact
 * list built from the repo's package.json "files" plus the offending path, and
 * asserts the path is no longer reported. Also asserts the negative still fires
 * for a path that is genuinely NOT allowlisted, so the check was not neutered.
 *
 * Usage: node --import tsx/esm scripts/ad-hoc/verify-pack-allowlist.mjs
 */
import {
  PACK_ARTIFACT_ALLOWED_EXACT_PATHS,
  PACK_ARTIFACT_ALLOWED_PATH_PREFIXES,
  PACK_ARTIFACT_REQUIRED_PATHS,
  findUnexpectedArtifactPaths,
  findMissingArtifactPaths,
} from "../../scripts/build/pack-artifact-policy.ts";

const OFFENDER = "scripts/build/fixPlaywrightAndroid.mjs";
// A real entry that is intentionally not allowlisted — used as the negative.
const CONTROL = "scripts/build/definitelyNotAllowlisted.mjs";

// Build the artifact list from the required set itself (plus allowlist-only
// entries), so the "missing" half of the check stays meaningful: an incomplete
// fixture would report missing paths and mask a real regression.
const artifact = [
  ...new Set([
    ...PACK_ARTIFACT_REQUIRED_PATHS,
    "package.json",
    "README.md",
    "LICENSE",
    "bin/omniroute.mjs",
    "bin/mcp-server.mjs",
    "bin/aliasResolver.mjs",
    "bin/aliasResolverHook.mjs",
    "bin/cli/program.mjs",
    "bin/cli/data-dir.mjs",
    "dist/server.js",
    "dist/server-ws.mjs",
    "dist/tls-options.mjs",
    "scripts/build/postinstall.mjs",
    "scripts/build/postinstallSupport.mjs",
    "scripts/build/colocateOptionals.mjs",
    "scripts/build/fixTlsClientNodeBinary.mjs",
    "scripts/build/fixPlaywrightAndroid.mjs",
    "src/shared/utils/nodeRuntimeSupport.ts",
  ]),
];

const opts = {
  exactPaths: PACK_ARTIFACT_ALLOWED_EXACT_PATHS,
  prefixPaths: PACK_ARTIFACT_ALLOWED_PATH_PREFIXES,
};

const unexpected = findUnexpectedArtifactPaths(artifact, opts);
const missing = findMissingArtifactPaths(artifact, PACK_ARTIFACT_REQUIRED_PATHS);

console.log(
  `  allowlist contains offender : ${PACK_ARTIFACT_ALLOWED_EXACT_PATHS.includes(OFFENDER)}`
);
console.log(`  required list contains it   : ${PACK_ARTIFACT_REQUIRED_PATHS.includes(OFFENDER)}`);
console.log(
  `  unexpected paths            : ${unexpected.length === 0 ? "(none)" : unexpected.join(", ")}`
);
console.log(
  `  missing required paths      : ${missing.length === 0 ? "(none)" : missing.join(", ")}`
);

// Negative control: the check must still reject a path that is not allowlisted.
const withControl = findUnexpectedArtifactPaths([...artifact, CONTROL], opts);
const controlCaught = withControl.includes(CONTROL);
console.log(`  control path still rejected : ${controlCaught}`);

let bad = 0;
if (unexpected.length !== 0) {
  console.log(`  FAIL  unexpected paths remain: ${unexpected.join(", ")}`);
  bad++;
}
if (missing.length !== 0) {
  console.log(`  FAIL  required paths missing: ${missing.join(", ")}`);
  bad++;
}
if (!controlCaught) {
  console.log("  FAIL  control path was NOT rejected — the allowlist check is neutered");
  bad++;
}
console.log(
  bad === 0
    ? "\n  PASS — the CI failure is resolved and the check still has teeth\n"
    : "\n  FAILED\n"
);
process.exitCode = bad === 0 ? 0 : 1;
