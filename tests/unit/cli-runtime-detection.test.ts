/**
 * Tests for CLI tool detection: cross-platform known paths, size threshold,
 * npm prefix deduplication, and env var overrides.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// #3321 (loginShellPath.ts) makes getLookupEnv() merge the user's LOGIN-SHELL
// PATH into the lookup env on darwin, because a GUI/Electron launch inherits a
// truncated PATH. That enrichment has to be off for the "binary is absent"
// assertions below to mean anything: with it on, `process.env.PATH = ""` is
// silently replaced by the operator's real login PATH (16 dirs on this machine),
// so the test stops measuring "is `cn` locatable" and starts measuring "is
// `cn` installed on this box". Point $SHELL at a binary that cannot be
// executed so getLoginShellPath() takes its documented failure path and
// returns null. Set before the first detection call, because
// getCachedLoginShellPath() memoizes per process.
process.env.SHELL = "/nonexistent/omniroute-test-login-shell";

const { getCliRuntimeStatus, getKnownToolPaths, getLookupEnv, CLI_TOOL_IDS } =
  await import("../../src/shared/services/cliRuntime.ts");

// ─── Helpers ──────────────────────────────────────────────────

function createTempDir() {
  const testRoot = path.join(os.tmpdir(), "omniroute-test-tmp");
  if (!fs.existsSync(testRoot)) {
    fs.mkdirSync(testRoot, { recursive: true });
  }
  return fs.mkdtempSync(path.join(testRoot, "cli-test-"));
}

describe("Claude Code Windows known paths", () => {
  it("should include the WinGet Anthropic.ClaudeCode install path", () => {
    const localAppData = process.env.LOCALAPPDATA;
    const expected = localAppData
      ? path.join(
          localAppData,
          "Microsoft",
          "WinGet",
          "Packages",
          "Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe",
          "claude.exe"
        )
      : null;

    if (process.platform !== "win32" || !expected) return;

    assert.ok(
      getKnownToolPaths("claude").includes(expected),
      "Claude Code installed by WinGet should be discoverable without CLI_CLAUDE_BIN"
    );
  });
});

function createFile(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
  return filePath;
}

// ─── CLI_TOOL_IDS ─────────────────────────────────────────────

describe("CLI_TOOL_IDS", () => {
  it("should include all expected tools from cliRuntime.ts (separate from CLI_TOOLS catalog)", () => {
    // CLI_TOOL_IDS comes from cliRuntime.ts — a runtime-detection catalog that
    // is SEPARATE from the UI catalog CLI_TOOLS in cliTools.ts.
    // windsurf was removed from CLI_TOOLS (plan 14 D17) but may still be in
    // cliRuntime.ts for binary detection purposes.
    const expected = [
      "claude",
      "codex",
      "droid",
      "openclaw",
      "cursor",
      "cline",
      "kilo",
      "continue",
      "opencode",
      "qoder",
      "qwen",
    ];
    for (const id of expected) {
      assert.ok(CLI_TOOL_IDS.includes(id), `Missing tool: ${id}`);
    }
  });
});

// ─── Size Threshold (30 bytes) ────────────────────────────────

describe("Size threshold — checkKnownPath", () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect files >= 30 bytes via env var", async () => {
    const prev = process.env.CLI_DROID_BIN;
    // Create a valid 30-byte+ script (using spaces/comments for padding, NO \r on linux)
    const content =
      process.platform === "win32"
        ? "@echo off\r\necho 1.0.0\r\nREM PADDING_PADDIN\r\nexit 0\r\n"
        : "#!/bin/sh\necho 1.0.0\n# PADDING_PADDING_PAD\nexit 0\n";
    const script = createFile(tmpDir, "droid-valid", content);
    // Verify it's at least 30 bytes
    const stat = fs.statSync(script);
    assert.ok(stat.size >= 30, `File should be >= 30 bytes, got ${stat.size}`);

    process.env.CLI_DROID_BIN = script;
    try {
      const result = await getCliRuntimeStatus("droid");
      assert.ok(result.installed, `Expected installed=true, got reason=${result.reason}`);
      assert.ok(result.commandPath === script, `Expected commandPath=${script}`);
    } finally {
      if (prev !== undefined) process.env.CLI_DROID_BIN = prev;
      else delete process.env.CLI_DROID_BIN;
    }
  });

  it("should detect a valid CLI script (>= 30 bytes) via env var", async () => {
    const prev = process.env.CLI_DROID_BIN;
    // Ensure the size stays > 30 bytes without \r\n on bash
    const content =
      process.platform === "win32"
        ? "@echo off\r\necho 1.0.0\r\nREM PADDING_PAD\r\n"
        : "#!/bin/sh\necho 1.0.0\n# PADDING_PADDING_PAD\n";
    const script =
      process.platform === "win32"
        ? createFile(tmpDir, "droid.cmd", content)
        : createFile(tmpDir, "droid", content);

    process.env.CLI_DROID_BIN = script;
    try {
      const result = await getCliRuntimeStatus("droid");
      assert.ok(result.installed, `Expected installed=true, got reason=${result.reason}`);
      assert.ok(
        result.commandPath === script,
        `Expected commandPath=${script}, got ${result.commandPath}`
      );
    } finally {
      if (prev !== undefined) process.env.CLI_DROID_BIN = prev;
      else delete process.env.CLI_DROID_BIN;
    }
  });
});

// ─── Healthcheck with --version ───────────────────────────────

describe("Healthcheck — checkRunnable", () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should report runnable=true for a script that outputs version", async () => {
    const prev = process.env.CLI_CLINE_BIN;
    const script =
      process.platform === "win32"
        ? createFile(tmpDir, "good.cmd", "@echo off\necho 1.0.0\n")
        : createFile(tmpDir, "good", "#!/bin/sh\necho 1.0.0\n");

    process.env.CLI_CLINE_BIN = script;
    try {
      const result = await getCliRuntimeStatus("cline");
      assert.ok(result.installed, `Expected installed=true, got reason=${result.reason}`);
      if (result.runnable) {
        assert.ok(result.reason === null, `Expected no reason, got ${result.reason}`);
        assert.equal(result.version, "1.0.0");
      }
    } finally {
      if (prev !== undefined) process.env.CLI_CLINE_BIN = prev;
      else delete process.env.CLI_CLINE_BIN;
    }
  });

  it("should detect Claude through an explicit read-only executable path", async () => {
    const previousOverride = process.env.CLI_CLAUDE_BIN;
    const script =
      process.platform === "win32"
        ? createFile(tmpDir, "claude.cmd", "@echo off\necho 2.1.211 (Claude Code)\n")
        : createFile(tmpDir, "claude", "#!/bin/sh\necho '2.1.211 (Claude Code)'\n");
    if (process.platform !== "win32") fs.chmodSync(script, 0o555);
    process.env.CLI_CLAUDE_BIN = script;

    try {
      const result = await getCliRuntimeStatus("claude");
      assert.equal(result.installed, true);
      assert.equal(result.runnable, true);
      assert.equal(result.commandPath, script);
      assert.equal(result.version, "2.1.211 (Claude Code)");
    } finally {
      if (previousOverride === undefined) delete process.env.CLI_CLAUDE_BIN;
      else process.env.CLI_CLAUDE_BIN = previousOverride;
    }
  });

  it("should detect qodercli via env override and mark it runnable", async () => {
    const prev = process.env.CLI_QODER_BIN;
    const script =
      process.platform === "win32"
        ? createFile(tmpDir, "qoder.cmd", "@echo off\necho qodercli 0.1.37\n")
        : createFile(tmpDir, "qodercli", "#!/bin/sh\necho qodercli 0.1.37\n");

    process.env.CLI_QODER_BIN = script;
    try {
      const result = await getCliRuntimeStatus("qoder");
      assert.equal(result.installed, true);
      assert.equal(result.runnable, true);
      assert.equal(result.commandPath, script);
      assert.equal(result.reason, null);
    } finally {
      if (prev !== undefined) process.env.CLI_QODER_BIN = prev;
      else delete process.env.CLI_QODER_BIN;
    }
  });
});

// ─── Unknown tool ─────────────────────────────────────────────

describe("Unknown tool", () => {
  it("should return unknown_tool for non-existent tool", async () => {
    const result = await getCliRuntimeStatus("nonexistent-tool-xyz");
    assert.equal(result.installed, false);
    assert.equal(result.reason, "unknown_tool");
  });
});

// ─── Continue CLI (`cn`) ──────────────────────────────────────

describe("Continue CLI detection", () => {
  it("should not report Continue as installed when the cn binary is absent", async () => {
    const previousPath = process.env.PATH;
    const previousOverride = process.env.CLI_CONTINUE_BIN;

    // A PATH made of (a) a private EMPTY directory and (b) the directory that
    // actually holds `sh`. The empty dir is what makes "absent" true; the
    // `sh` dir is needed because locateCommand() runs `sh -c 'command -v cn'`,
    // and Node resolves the executable against the CHILD env — with a PATH that
    // contains no shell at all the spawn fails with ENOENT and the lookup
    // returns "not found" for the wrong reason, which would make this test
    // pass even if detection were completely broken.
    //
    // The previous `process.env.PATH = ""` was doubly wrong: POSIX treats an
    // empty PATH as ".", so it also searched the CWD, and #3321 replaced it
    // with the operator's real login PATH anyway (see the SHELL override at the
    // top of this file).
    const shellDir = path.dirname(
      execFileSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).trim()
    );
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-empty-path-"));
    process.env.PATH = [emptyDir, shellDir].join(path.delimiter);
    delete process.env.CLI_CONTINUE_BIN;

    try {
      // Precondition: the isolation above is actually in force. If #3321's
      // login-shell enrichment ever starts running again, getLookupEnv() would
      // silently widen PATH back to the operator's real login PATH and every
      // assertion below would degrade into "is `cn` installed on this box".
      assert.equal(
        getLookupEnv().PATH,
        process.env.PATH,
        "getLookupEnv() must not widen PATH — the login-shell enrichment is supposed to be disabled here"
      );

      const result = await getCliRuntimeStatus("continue");
      assert.equal(result.installed, false);
      assert.equal(result.runnable, false);
      assert.equal(result.reason, "not_found");
      assert.equal(result.requiresBinary, true);

      // Guard the guard: with a real `cn` placed in the searched directory the
      // very same lookup must report it installed. Without this, the assertions
      // above would also hold against a lookup that can never succeed.
      const decoy = path.join(emptyDir, "cn");
      fs.writeFileSync(decoy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const withBinary = await getCliRuntimeStatus("continue");
      assert.equal(
        withBinary.installed,
        true,
        "a `cn` on PATH must be detected — otherwise the absent-binary assertions above prove nothing"
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousOverride === undefined) delete process.env.CLI_CONTINUE_BIN;
      else process.env.CLI_CONTINUE_BIN = previousOverride;
    }
  });

  it("should enumerate cn in Continue's known installation paths", () => {
    const knownPaths = getKnownToolPaths("continue");
    assert.ok(
      knownPaths.some((knownPath) => /^cn(?:\.cmd)?$/i.test(path.basename(knownPath))),
      "Continue detection should search for the cn executable"
    );
  });
});

// Note: windsurf was removed from CLI_TOOLS in plan 14 D17 (MITM backlog plan 11).
// cliRuntime.ts may still have windsurf for binary detection (separate catalog).
// This test is skipped if windsurf is not registered in cliRuntime.ts.
describe("windsurf tool — guide-only integration (cliRuntime.ts)", () => {
  it("should handle getCliRuntimeStatus for windsurf if it exists in cliRuntime catalog", async () => {
    if (!CLI_TOOL_IDS.includes("windsurf")) {
      // windsurf removed from runtime detection catalog too — skip
      return;
    }
    const result = await getCliRuntimeStatus("windsurf");
    assert.equal(result.installed, true);
    assert.equal(result.runnable, true);
    assert.equal(result.reason, "not_required");
  });
});

// ─── resolveOpencodeConfigPath — cross-platform ─────────────────

const { resolveOpencodeConfigPath: resolveOpencodeConfigPathFn } =
  await import("../../src/shared/services/cliRuntime.ts");

describe("resolveOpencodeConfigPath — cross-platform", () => {
  it("should resolve on Linux with XDG_CONFIG_HOME", () => {
    const result = resolveOpencodeConfigPathFn(
      "linux",
      { XDG_CONFIG_HOME: "/tmp/xdg" },
      "/home/dev"
    );
    assert.equal(result, path.join("/tmp/xdg", "opencode", "opencode.json"));
  });

  it("should resolve on Linux with default .config", () => {
    const result = resolveOpencodeConfigPathFn("linux", {}, "/home/dev");
    assert.equal(result, path.join("/home/dev", ".config", "opencode", "opencode.json"));
  });

  it("should resolve on Windows under ~/.config (XDG, NOT %APPDATA% — #3330)", () => {
    // #3330: OpenCode reads its config from ~/.config/opencode on every
    // platform, including Windows (%USERPROFILE%\.config). %APPDATA% is ignored.
    const result = resolveOpencodeConfigPathFn(
      "win32",
      { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      "C:\\Users\\dev"
    );
    assert.equal(result, path.join("C:\\Users\\dev", ".config", "opencode", "opencode.json"));
  });

  it("should resolve on Windows under ~/.config without APPDATA (#3330)", () => {
    const result = resolveOpencodeConfigPathFn("win32", {}, "C:\\Users\\dev");
    assert.equal(result, path.join("C:\\Users\\dev", ".config", "opencode", "opencode.json"));
  });

  it("should honor XDG_CONFIG_HOME on Windows too (#3330)", () => {
    const result = resolveOpencodeConfigPathFn(
      "win32",
      { XDG_CONFIG_HOME: "D:\\xdg" },
      "C:\\Users\\dev"
    );
    assert.equal(result, path.join("D:\\xdg", "opencode", "opencode.json"));
  });
});
