/**
 * CLI `board update` tests (runs the CLI against the mock board server)
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockBoardServer, type MockBoardServer } from "./helpers/boardMockServer.js";

const POST_ID = "pst_board_cli";
const INITIAL = "# Initial Whiteboard\n- Item 1";
const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("CLI board update", () => {
  let mockServer: MockBoardServer;
  let tmpDir: string;
  let credentialsPath: string;

  before(async () => {
    mockServer = await startMockBoardServer(POST_ID);
    // Dummy credentials with a non-expired token, so the CLI never calls login
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "allevitas-cli-"));
    credentialsPath = path.join(tmpDir, "credentials.json");
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        accountId: "test_bot",
        token: "dummy_jwt",
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      })
    );
  });

  after(async () => {
    await mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockServer.reset(INITIAL);
  });

  function runCli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return runCliWith({}, ...args);
  }

  function runCliWith(
    { credentials = credentialsPath, env: extraEnv = {} }: { credentials?: string; env?: Record<string, string> },
    ...args: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ["ALLEVITAS_DRY_RUN", "ALLEVITAS_ACCOUNT_ID", "ALLEVITAS_PASSWORD", "ALLEVITAS_TOKEN"]) {
      delete env[key];
    }
    Object.assign(env, extraEnv);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "board",
        "update",
        POST_ID,
        "-m",
        "CLI update",
        "--api-url",
        mockServer.url,
        "--credentials",
        credentials,
        "--no-save-credentials",
        ...args,
      ],
      { cwd: packageRoot, env }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
  }

  it("rejects invalid option combinations before locking", async () => {
    const invalidArgs = [
      ["--search", "a"], // --search without --replace
      ["--search", "a", "--replace", "b", "--content", "x"], // No.8
      [], // No.9
      ["--replace-all"], // No.14
      ["--replace-all", "--search", "a", "--replace", "b"], // No.15
    ];
    for (const args of invalidArgs) {
      const result = await runCli(...args);
      assert.equal(result.code, 1, `args: ${JSON.stringify(args)}`);
      assert.ok(result.stderr.includes("[Error]"), result.stderr);
    }
    assert.equal(mockServer.state.lockCalls, 0);
  });

  it("commits content as a diff and reports changed in JSON", async () => {
    const result = await runCli("--content", `${INITIAL}\n- Item 2`, "--json");
    assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.changed, true);
    assert.equal(data.version, 2);
    assert.deepEqual(mockServer.state.lastOperations, [{ search: "- Item 1", replace: "- Item 1\n- Item 2" }]);
  });

  it("logs in from env credentials with --no-save-credentials and no file", async () => {
    const missingPath = path.join(tmpDir, "missing", "credentials.json");
    const result = await runCliWith(
      { credentials: missingPath, env: { ALLEVITAS_ACCOUNT_ID: "test_bot", ALLEVITAS_PASSWORD: "Secret123" } },
      "--content",
      `${INITIAL}\n- Item 2`
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mockServer.state.loginCalls, 1);
    assert.equal(mockServer.state.lastAuthorization, "Bearer board_login_jwt");
    assert.equal(fs.existsSync(missingPath), false);
  });

  it("uses ALLEVITAS_TOKEN with --no-save-credentials and no file", async () => {
    const missingPath = path.join(tmpDir, "missing", "credentials.json");
    const result = await runCliWith(
      { credentials: missingPath, env: { ALLEVITAS_TOKEN: "env_jwt" } },
      "--content",
      `${INITIAL}\n- Item 2`
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mockServer.state.loginCalls, 0);
    assert.equal(mockServer.state.lastAuthorization, "Bearer env_jwt");
    assert.equal(fs.existsSync(missingPath), false);
  });

  it("prints a no-op message when nothing changes", async () => {
    const result = await runCli("--content", INITIAL);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes("Board unchanged (no commit)"), result.stdout);
    assert.equal(mockServer.state.commitCalls, 0);
  });

  it("requires --replace-all to clear the board", async () => {
    let result = await runCli("--content", "");
    assert.equal(result.code, 1);
    assert.equal(mockServer.state.commitCalls, 0);

    result = await runCli("--content", "", "--replace-all", "--json");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mockServer.state.content, "");
  });

  it("rejects a stale --version", async () => {
    const result = await runCli("--content", "# stale", "--version", "0");
    assert.equal(result.code, 1);
    assert.ok(result.stderr.toLowerCase().includes("version"), result.stderr);
    assert.equal(mockServer.state.commitCalls, 0);
    assert.equal(mockServer.state.content, INITIAL);
  });
});
