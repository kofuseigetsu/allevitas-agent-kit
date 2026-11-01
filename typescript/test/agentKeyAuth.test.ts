/**
 * Agent key authentication tests (no API key required, uses a mock server)
 */

import "./helpers/testEnv.js";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  AllevitasApiError,
  AllevitasAuthError,
  AllevitasClient,
  ClientOptions,
  createKeyringBackend,
  KeyringBackend,
  maskSecrets,
  MCPServer,
  RateLimitHandler,
  storeInKeyring,
  withFileLock,
  writeFileAtomic,
} from "../src/index.js";
import { AgentKeyMockServer, startAgentKeyMockServer } from "./helpers/agentKeyMockServer.js";

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
const ENV_KEYS = [
  "ALLEVITAS_AGENT_KEY",
  "ALLEVITAS_TOKEN",
  "ALLEVITAS_ACCOUNT_ID",
  "ALLEVITAS_RECOVERY_KEY_FILE",
  "ALLEVITAS_AUTO_ROTATE",
  "ALLEVITAS_SAVE_CREDENTIALS",
  "ALLEVITAS_NO_SAVE_CREDENTIALS",
  "ALLEVITAS_DRY_RUN",
  "ALLEVITAS_PASSWORD",
];

class FakeKeyring implements KeyringBackend {
  entries = new Map<string, string>();
  failWrites = false;
  get(account: string) {
    return this.entries.get(account) ?? null;
  }
  set(account: string, secret: string) {
    if (this.failWrites) return false;
    this.entries.set(account, secret);
    return true;
  }
  delete(account: string) {
    this.entries.delete(account);
  }
}

describe("Agent key authentication", () => {
  let mock: AgentKeyMockServer;
  let tmpDir: string;
  let credPath: string;
  let recoveryPath: string;
  let stderrLines: string[];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const savedEnv: Record<string, string | undefined> = {};

  const createClient = (options: ClientOptions = {}) =>
    new AllevitasClient({ apiUrl: mock.url, credentialsPath: credPath, keyring: false, maxRetries: 0, ...options });
  const readCredentials = () => JSON.parse(fs.readFileSync(credPath, "utf-8"));
  const writeCredentials = (data: Record<string, unknown>) => fs.writeFileSync(credPath, JSON.stringify(data), { mode: 0o600 });
  const seedStore = (extra: Record<string, unknown> = {}) => {
    mock.state.keys.set("alv_sk_storedkeyvalue", "active");
    writeCredentials({ accountId: "key_bot", agentKey: "alv_sk_storedkeyvalue", keyCreatedAt: Date.now(), ...extra });
  };
  const stderrOutput = () => stderrLines.join("");
  const withoutSecrets = (mockSolverClient: AllevitasClient) => {
    (mockSolverClient.auth as any).challengeSolver = {
      fetchChallenge: async () => ({ id: "c1", puzzleType: "LOG_FILTERING", prompt: "p", expiresAt: Date.now() + 30000 }),
      solve: async () => ({ matchCount: 1, totalBytes: 1, targetIds: [] }),
      getReflectionKnowledge: () => [],
    };
    return mockSolverClient;
  };

  before(async () => {
    mock = await startAgentKeyMockServer();
  });

  after(async () => {
    await mock.close();
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "allevitas-agent-key-"));
    credPath = path.join(tmpDir, "credentials.json");
    recoveryPath = path.join(tmpDir, "key_bot.recovery-key.json");
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mock.state.keys.clear();
    mock.state.claimCodes.clear();
    mock.state.password = null;
    mock.state.recoveryKeyId = "currentrkid0";
    mock.state.tokenVersion = 0;
    mock.state.tokenRequests.length = 0;
    mock.state.apiAuthorizations.length = 0;
    mock.state.migrateCalls = 0;
    mock.state.failTokenRequests = 0;
    mock.state.nextApiError = null;
    mock.state.dryRunHeaders.length = 0;

    stderrLines = [];
    process.stderr.write = ((chunk: string) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("token exchange", () => {
    it("exchanges the stored key and sends only the access token to the API", async () => {
      seedStore();
      const client = createClient();

      await client.getProfile();

      assert.deepEqual(mock.state.tokenRequests, [{ agentKey: "alv_sk_storedkeyvalue" }]);
      assert.equal(mock.state.apiAuthorizations.length, 1);
      assert.match(mock.state.apiAuthorizations[0], /^Bearer jwt_v0_/);
    });

    it("reuses a fresh token and refreshes one that is about to expire", async () => {
      seedStore();
      const client = createClient();
      const first = await client.auth.getValidToken();
      assert.equal(await client.auth.getValidToken(), first);
      assert.equal(mock.state.tokenRequests.length, 1);

      (client.auth as any).tokenExpiresAt = Date.now() + 30 * 1000;
      assert.notEqual(await client.auth.getValidToken(), first);
      assert.equal(mock.state.tokenRequests.length, 2);
    });

    it("shares one exchange between parallel requests", async () => {
      seedStore();
      const client = createClient();
      await Promise.all([client.getProfile(), client.getProfile(), client.getProfile()]);
      assert.equal(mock.state.tokenRequests.length, 1);
    });

    it("exchanges again and retries once after a plain 401", async () => {
      seedStore();
      const client = createClient();
      await client.auth.getValidToken();
      mock.state.nextApiError = { status: 401 };

      await client.getProfile();

      assert.equal(mock.state.tokenRequests.length, 2);
      assert.equal(mock.state.apiAuthorizations.length, 2);
    });

    it("keeps the injected token until the server rejects it, then uses the key", async () => {
      seedStore();
      const client = createClient({ token: "jwt_v0_injected" });
      await client.getProfile();
      assert.equal(mock.state.tokenRequests.length, 0);

      mock.state.tokenVersion = 1;
      await client.getProfile();
      assert.equal(mock.state.tokenRequests.length, 1);
    });

    it("reads ALLEVITAS_AGENT_KEY and never writes it to disk", async () => {
      mock.state.keys.set("alv_sk_fromenv", "active");
      process.env.ALLEVITAS_AGENT_KEY = "alv_sk_fromenv";
      const client = createClient();

      await client.getProfile();

      assert.equal(client.auth.accountId, "key_bot");
      assert.equal(fs.existsSync(credPath), false);
    });

    it("does not let an environment key overwrite the store of another account", async () => {
      mock.state.keys.set("alv_sk_fromenv", "active");
      writeCredentials({ accountId: "other_bot", agentKey: "alv_sk_otherbot" });
      process.env.ALLEVITAS_AGENT_KEY = "alv_sk_fromenv";

      await createClient().getProfile();

      assert.equal(readCredentials().agentKey, "alv_sk_otherbot");
    });

    it("saves an imported key and manages it from the store", async () => {
      mock.state.keys.set("alv_sk_imported", "active");
      const client = createClient({ agentKey: "alv_sk_imported", importAgentKey: true });
      await client.getProfile();

      assert.equal(readCredentials().agentKey, "alv_sk_imported");
      assert.equal(createClient().auth.getStatus().keySource, "store");
    });

    it("does not retry a revoked key and reports what to do", async () => {
      mock.state.keys.set("alv_sk_storedkeyvalue", "ROTATED");
      writeCredentials({ accountId: "key_bot", agentKey: "alv_sk_storedkeyvalue" });
      const client = createClient();

      await assert.rejects(client.getProfile(), (err: any) => {
        assert.ok(err instanceof AllevitasAuthError);
        assert.equal(err.code, "KEY_ROTATED");
        assert.match(err.message, /may have leaked/);
        assert.match(err.message, /\/recover\/agent/);
        return true;
      });
      await assert.rejects(client.getProfile(), /may have leaked/);
      assert.equal(mock.state.tokenRequests.length, 1);
    });

    it("reports recovery revocation as a possible recovery key leak", async () => {
      mock.state.keys.set("alv_sk_storedkeyvalue", "RECOVERY");
      writeCredentials({ accountId: "key_bot", agentKey: "alv_sk_storedkeyvalue" });
      await assert.rejects(createClient().getProfile(), (err: any) => {
        assert.equal(err.code, "KEY_REVOKED_BY_RECOVERY");
        assert.match(err.message, /recovery key may have leaked/);
        return true;
      });
    });

    it("follows a rotation another process saved instead of reporting a leak", async () => {
      seedStore();
      const client = createClient();
      await client.auth.getValidToken();

      // Another process rotates and rewrites the shared store
      mock.state.keys.set("alv_sk_storedkeyvalue", "ROTATED");
      mock.state.keys.set("alv_sk_newer", "active");
      writeCredentials({ accountId: "key_bot", agentKey: "alv_sk_newer", keyCreatedAt: Date.now() });

      (client.auth as any).currentToken = null;
      await client.getProfile();

      assert.equal(readCredentials().agentKey, "alv_sk_newer");
    });

    it("a token refresh does not undo a rotation saved by another process", async () => {
      seedStore();
      const client = createClient();
      await client.auth.getValidToken();

      writeCredentials({ accountId: "key_bot", agentKey: "alv_sk_newer", keyCreatedAt: Date.now() });
      await client.auth.saveCredentials();

      assert.equal(readCredentials().agentKey, "alv_sk_newer");
    });
  });

  describe("rotation", () => {
    it("rotate() saves K2 before committing it, and K1 is revoked only after the exchange", async () => {
      seedStore();
      const client = createClient();

      const result = await client.rotate();

      assert.equal(result.committed, true);
      const k2 = readCredentials().agentKey;
      assert.notEqual(k2, "alv_sk_storedkeyvalue");
      assert.equal(readCredentials().pendingAgentKey, undefined);
      assert.equal(mock.state.keys.get("alv_sk_storedkeyvalue"), "ROTATED");
      assert.equal(mock.state.keys.get(k2), "active");
      assert.equal(mock.state.tokenVersion, 0);
      assert.deepEqual(mock.state.tokenRequests[0], { agentKey: "alv_sk_storedkeyvalue", rotate: true });
      assert.deepEqual(mock.state.tokenRequests[1], { agentKey: k2 });
    });

    it("keeps K1 and retries on the next refresh when the commit exchange fails", async () => {
      seedStore();
      const client = createClient();
      const realPost = (client.auth as any).postToken.bind(client.auth);
      let calls = 0;
      (client.auth as any).postToken = async (body: any, options: any) => {
        calls++;
        if (calls === 2) {
          throw new Error("connection reset");
        }
        return await realPost(body, options);
      };

      const result = await client.rotate();

      assert.equal(result.rotated, true);
      assert.equal(result.committed, false);
      const saved = readCredentials();
      assert.equal(saved.agentKey, "alv_sk_storedkeyvalue");
      assert.ok(saved.pendingAgentKey);
      assert.equal(mock.state.keys.get("alv_sk_storedkeyvalue"), "active");

      // A new process picks up the pending key and commits it
      await createClient().getProfile();
      assert.equal(readCredentials().agentKey, saved.pendingAgentKey);
      assert.equal(mock.state.keys.get("alv_sk_storedkeyvalue"), "ROTATED");
    });

    it("commits a pending key whose earlier exchange succeeded but lost the response", async () => {
      seedStore({ pendingAgentKey: "alv_sk_pending" });
      mock.state.keys.set("alv_sk_storedkeyvalue", "ROTATED");
      mock.state.keys.set("alv_sk_pending", "active");

      await createClient().getProfile();

      const saved = readCredentials();
      assert.equal(saved.agentKey, "alv_sk_pending");
      assert.equal(saved.pendingAgentKey, undefined);
    });

    it("drops a superseded pending key and keeps using K1", async () => {
      seedStore({ pendingAgentKey: "alv_sk_superseded" });
      mock.state.keys.set("alv_sk_superseded", "SUPERSEDED");

      await createClient().getProfile();

      const saved = readCredentials();
      assert.equal(saved.agentKey, "alv_sk_storedkeyvalue");
      assert.equal(saved.pendingAgentKey, undefined);
    });

    it("discards K2 and keeps K1 when K2 cannot be saved", async () => {
      seedStore();
      const client = createClient();
      (client.auth as any).persist = () => {
        throw new Error("disk full");
      };

      await assert.rejects(client.rotate(), /disk full/);

      assert.equal(readCredentials().agentKey, "alv_sk_storedkeyvalue");
      assert.equal(mock.state.keys.get("alv_sk_storedkeyvalue"), "active");
      assert.equal((client.auth as any).pendingAgentKey, null);
    });

    it("rotateNow() commits immediately and revokes issued tokens", async () => {
      seedStore();
      const client = createClient();
      const oldToken = await client.auth.getValidToken();

      await client.rotateNow();

      assert.equal(mock.state.tokenRequests[1].revokeTokens, true);
      assert.equal(mock.state.tokenVersion, 1);
      assert.notEqual(await client.auth.getValidToken(), oldToken);
      await client.getProfile();
    });

    it("rotates automatically once the key is 30 days old", async () => {
      seedStore({ keyCreatedAt: Date.now() - THIRTY_ONE_DAYS_MS });
      await createClient().getProfile();
      assert.notEqual(readCredentials().agentKey, "alv_sk_storedkeyvalue");
    });

    it("does not rotate a younger key", async () => {
      seedStore();
      await createClient().getProfile();
      assert.equal(readCredentials().agentKey, "alv_sk_storedkeyvalue");
    });

    for (const [name, prepare] of [
      ["autoRotate: false", () => ({ autoRotate: false })],
      ["ALLEVITAS_AUTO_ROTATE=false", () => ((process.env.ALLEVITAS_AUTO_ROTATE = "false"), {})],
      ["saveCredentials: false", () => ({ saveCredentials: false })],
      ["dryRun", () => ({ dryRun: true })],
    ] as [string, () => ClientOptions][]) {
      it(`does not auto-rotate with ${name}`, async () => {
        seedStore({ keyCreatedAt: Date.now() - THIRTY_ONE_DAYS_MS });
        const options = prepare();
        await createClient(options).auth.getValidToken();
        assert.equal(mock.state.tokenRequests.filter((r) => r.rotate).length, 0);
      });
    }

    it("does not auto-rotate a key from ALLEVITAS_AGENT_KEY", async () => {
      mock.state.keys.set("alv_sk_fromenv", "active");
      process.env.ALLEVITAS_AGENT_KEY = "alv_sk_fromenv";
      const client = createClient();
      (client.auth as any).keyCreatedAt = Date.now() - THIRTY_ONE_DAYS_MS;
      await client.auth.getValidToken();
      assert.equal(mock.state.tokenRequests.filter((r) => r.rotate).length, 0);
    });

    it("refuses a manual rotation when the new key could not be kept", async () => {
      mock.state.keys.set("alv_sk_fromenv", "active");
      process.env.ALLEVITAS_AGENT_KEY = "alv_sk_fromenv";
      await assert.rejects(createClient().rotate(), (err: any) => {
        assert.equal(err.code, "KEY_NOT_ROTATABLE");
        return true;
      });
      assert.equal(mock.state.tokenRequests.length, 0);
    });

    it("a failed automatic rotation does not fail the request", async () => {
      seedStore({ keyCreatedAt: Date.now() - THIRTY_ONE_DAYS_MS });
      fs.closeSync(fs.openSync(`${credPath}.lock`, "w"));

      await createClient().getProfile();

      assert.match(stderrOutput(), /Automatic key rotation failed/);
      assert.equal(readCredentials().agentKey, "alv_sk_storedkeyvalue");
    });

    it("--dry-run style rotation changes nothing", async () => {
      seedStore();
      const res = await createClient({ dryRun: true }).rotate();
      assert.deepEqual(res, { rotated: false, committed: false, dryRun: true });
      assert.equal(readCredentials().agentKey, "alv_sk_storedkeyvalue");
      assert.deepEqual(mock.state.dryRunHeaders, ["/auth/token"]);
    });
  });

  describe("migration from password", () => {
    const seedLegacy = (extra: Record<string, unknown> = {}) => {
      mock.state.password = "OldPass123";
      writeCredentials({
        accountId: "key_bot",
        password: "OldPass123",
        token: "old_jwt",
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        ...extra,
      });
    };

    it("migrates on the first token request, even with an unexpired old token", async () => {
      seedLegacy();
      const client = createClient();

      await client.getProfile();

      assert.equal(mock.state.migrateCalls, 1);
      const saved = readCredentials();
      assert.equal(saved.password, undefined);
      assert.match(saved.agentKey, /^alv_sk_/);
      assert.notEqual(saved.token, "old_jwt");
      assert.match(mock.state.apiAuthorizations[0], /^Bearer jwt_v0_/);
    });

    it("moves the legacy recovery key to its own file with the migrate response id", async () => {
      seedLegacy({ recoveryKey: "RC-00000000aaaaaaaa" });

      await createClient().getProfile();

      assert.equal(readCredentials().recoveryKey, undefined);
      const file = JSON.parse(fs.readFileSync(recoveryPath, "utf-8"));
      assert.equal(file.recoveryKey, "RC-00000000aaaaaaaa");
      assert.equal(file.recoveryKeyId, "currentrkid0");
      assert.equal(file.format, "legacy_rc");
      assert.equal(file.accountId, "key_bot");
      assert.ok(!stderrOutput().includes("RC-00000000aaaaaaaa"));
      assert.match(stderrOutput(), /recovery-key export/);
    });

    it("migrates when an injected token gets AGENT_KEY_REQUIRED", async () => {
      seedLegacy();
      const client = createClient({ token: "jwt_v0_old" });
      mock.state.nextApiError = { status: 401, code: "AGENT_KEY_REQUIRED" };

      await client.getProfile();

      assert.equal(mock.state.migrateCalls, 1);
    });

    it("explains the way forward on AGENT_KEY_REQUIRED without a password", async () => {
      const client = createClient({ token: "jwt_v0_old" });
      mock.state.nextApiError = { status: 401, code: "AGENT_KEY_REQUIRED" };

      await assert.rejects(client.getProfile(), (err: any) => {
        assert.equal(err.code, "AGENT_KEY_REQUIRED");
        assert.match(err.message, /allevitas migrate/);
        return true;
      });
    });

    it("refuses to migrate where the key could not be saved", async () => {
      seedLegacy();
      await assert.rejects(createClient({ saveCredentials: false }).getProfile(), (err: any) => {
        assert.equal(err.code, "CREDENTIALS_NOT_PERSISTABLE");
        return true;
      });
      assert.equal(mock.state.migrateCalls, 0);
      assert.equal(mock.state.password, "OldPass123");
    });

    it("does not migrate in dry-run mode", async () => {
      seedLegacy();
      await assert.rejects(createClient({ dryRun: true }).auth.getValidToken(), (err: any) => {
        assert.equal(err.code, "MIGRATION_REQUIRED");
        return true;
      });
      assert.equal(mock.state.migrateCalls, 0);
      assert.equal(mock.state.password, "OldPass123");
      assert.equal(readCredentials().password, "OldPass123");
    });

    it("uses the key another process saved when the password was already consumed", async () => {
      seedLegacy();
      const client = createClient();
      mock.state.password = null;
      mock.state.keys.set("alv_sk_first", "active");
      writeCredentials({ accountId: "key_bot", agentKey: "alv_sk_first", keyCreatedAt: Date.now() });

      await client.getProfile();

      assert.equal(mock.state.migrateCalls, 0);
      assert.equal(readCredentials().agentKey, "alv_sk_first");
    });

    it("explains a rejected migration", async () => {
      seedLegacy({ password: "WrongPass" });
      await assert.rejects(createClient().getProfile(), (err: any) => {
        assert.equal(err.code, "MIGRATION_FAILED");
        return true;
      });
      assert.equal(readCredentials().password, "WrongPass");
    });

    it("migrate() accepts an explicit password for accounts without a file", async () => {
      mock.state.password = "OldPass123";
      const res = await createClient().migrate("key_bot", "OldPass123");
      assert.equal(res.migrated, true);
      assert.match(readCredentials().agentKey, /^alv_sk_/);
    });

    it("keeps the legacy key in place when the target file belongs to another account", async () => {
      const otherFile = path.join(tmpDir, "shared.json");
      fs.writeFileSync(otherFile, JSON.stringify({ accountId: "other_bot", recoveryKey: "alv_rk_other", recoveryKeyId: "x" }));
      process.env.ALLEVITAS_RECOVERY_KEY_FILE = otherFile;
      seedLegacy({ recoveryKey: "RC-00000000aaaaaaaa" });

      await createClient().getProfile();

      assert.equal(readCredentials().recoveryKey, "RC-00000000aaaaaaaa");
      assert.equal(JSON.parse(fs.readFileSync(otherFile, "utf-8")).accountId, "other_bot");
    });
  });

  describe("registration", () => {
    it("sends no password, saves the key, and writes the recovery key to a separate file", async () => {
      const client = withoutSecrets(createClient());

      const res = await client.register("key_bot");

      const json = JSON.stringify(res);
      assert.ok(!json.includes("alv_sk_"));
      assert.ok(!json.includes("alv_rk_"));
      assert.equal(res.recoveryKeyFile, recoveryPath);
      assert.equal(res.recoveryKeyId, "currentrkid0");

      const saved = readCredentials();
      assert.match(saved.agentKey, /^alv_sk_/);
      assert.equal(saved.recoveryKey, undefined);
      assert.ok(!fs.readFileSync(credPath, "utf-8").includes("alv_rk_"));

      const file = JSON.parse(fs.readFileSync(recoveryPath, "utf-8"));
      assert.deepEqual(
        { ...file, createdAt: undefined },
        {
          accountId: "key_bot",
          recoveryKey: "alv_rk_registered",
          recoveryKeyId: "currentrkid0",
          format: "alv_rk",
          createdAt: undefined,
        }
      );
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(recoveryPath).mode & 0o777, 0o600);
        assert.equal(fs.statSync(credPath).mode & 0o777, 0o600);
      }
    });

    it("honors ALLEVITAS_RECOVERY_KEY_FILE", async () => {
      process.env.ALLEVITAS_RECOVERY_KEY_FILE = path.join(tmpDir, "custom", "rk.json");
      await withoutSecrets(createClient()).register("key_bot");
      assert.ok(fs.existsSync(process.env.ALLEVITAS_RECOVERY_KEY_FILE));
      assert.equal(fs.existsSync(recoveryPath), false);
    });

    it("refuses in a stateless environment without an explicit recovery key file", async () => {
      const client = withoutSecrets(createClient({ saveCredentials: false }));
      await assert.rejects(client.register("key_bot"), (err: any) => {
        assert.equal(err.code, "CREDENTIALS_NOT_PERSISTABLE");
        return true;
      });
      assert.equal(mock.state.keys.size, 0);
    });

    it("allows a dry run in a stateless environment and writes nothing", async () => {
      const client = withoutSecrets(createClient({ saveCredentials: false }));
      const res = await client.register("key_bot", undefined, undefined, { dryRun: true });
      assert.equal(res.dryRun, true);
      assert.equal(fs.existsSync(recoveryPath), false);
      assert.equal(client.auth.getStatus().hasAgentKey, false);
    });

    it("warns that the key is lost in a stateless environment with a recovery key file", async () => {
      process.env.ALLEVITAS_RECOVERY_KEY_FILE = path.join(tmpDir, "rk.json");
      await withoutSecrets(createClient({ saveCredentials: false })).register("key_bot");
      assert.match(stderrOutput(), /will be lost/);
      assert.ok(fs.existsSync(process.env.ALLEVITAS_RECOVERY_KEY_FILE));
    });

    it("refuses to overwrite credentials of another account", async () => {
      writeCredentials({ accountId: "other_bot", agentKey: "alv_sk_otherbot" });
      const client = withoutSecrets(createClient({ accountId: "key_bot" }));
      await assert.rejects(client.register("key_bot"), (err: any) => {
        assert.equal(err.code, "CREDENTIALS_FILE_IN_USE");
        return true;
      });
      assert.equal(readCredentials().agentKey, "alv_sk_otherbot");
    });

    it("refuses to overwrite an undelivered recovery key", async () => {
      fs.writeFileSync(recoveryPath, JSON.stringify({ accountId: "key_bot", recoveryKey: "alv_rk_old", recoveryKeyId: "x" }));
      await assert.rejects(withoutSecrets(createClient()).register("key_bot"), (err: any) => {
        assert.equal(err.code, "RECOVERY_KEY_PENDING");
        return true;
      });
      assert.equal(JSON.parse(fs.readFileSync(recoveryPath, "utf-8")).recoveryKey, "alv_rk_old");
    });
  });

  describe("recovery key file", () => {
    const seedRecovery = (accountId: string, recoveryKeyId: string, filePath = recoveryPath) =>
      fs.writeFileSync(
        filePath,
        JSON.stringify({ accountId, recoveryKey: "alv_rk_value", recoveryKeyId, format: "alv_rk", createdAt: "2026-11-01" })
      );

    it("notifies on startup without showing the value", () => {
      seedStore();
      seedRecovery("key_bot", "currentrkid0");
      createClient();
      assert.match(stderrOutput(), /undelivered recovery key/);
      assert.match(stderrOutput(), /recovery-key export/);
      assert.ok(!stderrOutput().includes("alv_rk_value"));
    });

    it("stays quiet when no file exists", () => {
      seedStore();
      createClient();
      assert.equal(stderrOutput(), "");
    });

    it("keeps a file whose id matches the server", async () => {
      seedStore();
      seedRecovery("key_bot", "currentrkid0");
      await createClient().auth.getValidToken();
      assert.ok(fs.existsSync(recoveryPath));
    });

    it("silently deletes a file the server no longer recognizes", async () => {
      seedStore();
      seedRecovery("key_bot", "renewedalrdy");
      await createClient({ recoveryKeyNotice: false }).auth.getValidToken();
      assert.equal(fs.existsSync(recoveryPath), false);
      assert.equal(stderrOutput(), "");
    });

    it("keeps a file without a recorded id", async () => {
      seedStore();
      seedRecovery("key_bot", "");
      await createClient().auth.getValidToken();
      assert.ok(fs.existsSync(recoveryPath));
    });

    it("warns and keeps a file that belongs to another account", async () => {
      seedStore();
      const otherFile = path.join(tmpDir, "other.json");
      seedRecovery("other_bot", "renewedalrdy", otherFile);
      process.env.ALLEVITAS_RECOVERY_KEY_FILE = otherFile;

      await createClient().auth.getValidToken();

      assert.ok(fs.existsSync(otherFile));
      assert.match(stderrOutput(), /belongs to account other_bot/);
    });
  });

  describe("claim", () => {
    it("saves the new key, returns no key, and clears a previous failure", async () => {
      mock.state.keys.set("alv_sk_storedkeyvalue", "RECOVERY");
      writeCredentials({ accountId: "key_bot", agentKey: "alv_sk_storedkeyvalue", password: "old", recoveryKey: "RC-00000000aaaaaaaa" });
      mock.state.claimCodes.set("alv_cc_good", "unused");
      const client = createClient();
      await assert.rejects(client.auth.getValidToken(), /recovery/);

      const res = await client.claim("alv_cc_good");

      assert.ok(!JSON.stringify(res).includes(readCredentials().agentKey));
      assert.equal(res.accountId, "key_bot");
      const saved = readCredentials();
      assert.match(saved.agentKey, /^alv_sk_/);
      assert.equal(saved.password, undefined);
      assert.equal(saved.recoveryKey, undefined);
      await client.getProfile();
    });

    it("explains a used code as possibly stolen", async () => {
      mock.state.claimCodes.set("alv_cc_used", "used");
      await assert.rejects(createClient().claim("alv_cc_used"), (err: any) => {
        assert.equal(err.code, "CLAIM_CODE_USED");
        assert.match(err.message, /stolen/);
        assert.match(err.message, /recovery again/);
        return true;
      });
    });

    it("asks for another recovery on an expired code", async () => {
      mock.state.claimCodes.set("alv_cc_old", "expired");
      await assert.rejects(createClient().claim("alv_cc_old"), (err: any) => {
        assert.equal(err.code, "CLAIM_CODE_EXPIRED");
        assert.ok(!/stolen/.test(err.message));
        return true;
      });
    });

    it("does not retry a claim whose response was lost", async () => {
      mock.state.claimCodes.set("alv_cc_good", "unused");
      mock.state.failTokenRequests = 1;
      const client = createClient({ maxRetries: 3, baseDelayMs: 1 });
      await assert.rejects(client.claim("alv_cc_good"), /503/);
      assert.equal(mock.state.tokenRequests.length, 1);
    });

    it("rejects anything that is not a claim code before sending it", async () => {
      await assert.rejects(createClient().claim("alv_sk_notacode"), /starts with alv_cc_/);
      assert.equal(mock.state.tokenRequests.length, 0);
    });

    it("refuses without credential saving, before consuming the code", async () => {
      mock.state.claimCodes.set("alv_cc_good", "unused");
      await assert.rejects(createClient({ saveCredentials: false }).claim("alv_cc_good"), (err: any) => {
        assert.equal(err.code, "CREDENTIALS_NOT_PERSISTABLE");
        return true;
      });
      assert.equal(mock.state.claimCodes.get("alv_cc_good"), "unused");
    });

    it("replaces an environment key with the saved one", async () => {
      mock.state.claimCodes.set("alv_cc_good", "unused");
      process.env.ALLEVITAS_AGENT_KEY = "alv_sk_revoked";
      const client = createClient();

      await client.claim("alv_cc_good");

      assert.match(stderrOutput(), /Remove the old ALLEVITAS_AGENT_KEY/);
      assert.equal(client.auth.getStatus().keySource, "store");
      assert.match(readCredentials().agentKey, /^alv_sk_issued/);
    });
  });

  describe("secret protection", () => {
    it("masks every key format", () => {
      const masked = maskSecrets("a alv_sk_abc123 b alv_rk_abc123 c alv_cc_abc123 d RC-00000000aaaaaaaa e rc-00000000AAAAAAAA f");
      assert.equal(masked, "a [FILTERED] b [FILTERED] c [FILTERED] d [FILTERED] e [FILTERED] f");
    });

    it("leaves ordinary text alone", () => {
      assert.equal(maskSecrets("ARC-1 RC-12 rate limit"), "ARC-1 RC-12 rate limit");
    });

    it("masks keys echoed in API errors", async () => {
      const handler = new RateLimitHandler({ maxRetries: 0 });
      const response = () =>
        Promise.resolve(new Response('{"error":"bad alv_sk_leaked1"}', { status: 400, statusText: "Bad Request" }));
      await assert.rejects(handler.execute(response), (err: any) => {
        assert.ok(err instanceof AllevitasApiError);
        assert.ok(!err.message.includes("alv_sk_leaked1"));
        return true;
      });
    });

    it("exposes no secret through inspection, JSON, or string conversion", async () => {
      seedStore({ password: "ignored", recoveryKey: "RC-00000000aaaaaaaa" });
      const client = createClient();
      await client.auth.getValidToken();

      for (const text of [
        inspect(client, { depth: 8, showHidden: true }),
        inspect(client.auth),
        JSON.stringify(client.auth),
        String(client.auth),
      ]) {
        assert.ok(!text.includes("alv_sk_storedkeyvalue"), text.slice(0, 200));
        assert.ok(!text.includes("RC-00000000aaaaaaaa"));
      }
    });

    it("keeps an agentKey option out of the stored options", () => {
      const client = createClient({ agentKey: "alv_sk_option" });
      assert.ok(!JSON.stringify((client.auth as any).options).includes("alv_sk_option"));
    });

    it("loadCredentials() returns no secret values", () => {
      seedStore({ token: "secret-token", password: "pw" });
      const client = createClient();
      const text = JSON.stringify(client.auth.loadCredentials());
      assert.ok(!text.includes("alv_sk_storedkeyvalue"));
      assert.ok(!text.includes("secret-token"));
      assert.ok(text.includes("alv_sk_storedkey".slice(0, 15)));
    });
  });

  describe("MCP", () => {
    const call = async (server: MCPServer, name: string, args: Record<string, unknown> = {}) => {
      const res: any = await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      return res.result;
    };

    it("register returns neither key, only the recovery key file path", async () => {
      const server = new MCPServer(withoutSecrets(createClient()));
      const result = await call(server, "allevitas_register", { accountId: "key_bot" });

      const text = result.content[0].text;
      assert.equal(result.isError, false);
      assert.ok(!text.includes("alv_sk_"));
      assert.ok(!text.includes("alv_rk_"));
      assert.equal(JSON.parse(text).recoveryKeyFile, recoveryPath);
      assert.match(readCredentials().agentKey, /^alv_sk_/);
    });

    it("register fails without credential saving, even with a recovery key file", async () => {
      process.env.ALLEVITAS_RECOVERY_KEY_FILE = path.join(tmpDir, "rk.json");
      const server = new MCPServer(withoutSecrets(createClient({ saveCredentials: false })));
      const result = await call(server, "allevitas_register", { accountId: "key_bot" });
      assert.equal(result.isError, true);
      assert.equal(mock.state.keys.size, 0);
    });

    it("has no password parameter, no login tool, and no recovery key tool", () => {
      const tools = new MCPServer(createClient()).getTools();
      const names = tools.map((t) => t.name);
      assert.equal(names.includes("allevitas_login"), false);
      assert.ok(!names.some((n) => n.includes("recovery")));
      assert.ok(!JSON.stringify(tools.map((t) => t.inputSchema)).includes("password"));
    });

    it("claim returns no key", async () => {
      mock.state.claimCodes.set("alv_cc_good", "unused");
      const result = await call(new MCPServer(createClient()), "allevitas_claim", { code: "alv_cc_good" });
      assert.equal(result.isError, false);
      assert.ok(!result.content[0].text.includes(readCredentials().agentKey));
    });

    it("whoami returns only non-secret values", async () => {
      seedStore();
      const result = await call(new MCPServer(createClient()), "allevitas_whoami");
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.hasToken, true);
      assert.equal(data.accountId, "key_bot");
      assert.ok(!result.content[0].text.includes("alv_sk_storedkeyvalue"));
    });

    it("rotate_key and list_keys return only prefixes", async () => {
      seedStore();
      const server = new MCPServer(createClient());
      const rotated = await call(server, "allevitas_rotate_key");
      assert.equal(JSON.parse(rotated.content[0].text).committed, true);
      assert.ok(!rotated.content[0].text.includes(readCredentials().agentKey));
      const listed = await call(server, "allevitas_list_keys");
      assert.equal(listed.isError, false);
      assert.ok(!listed.content[0].text.includes(readCredentials().agentKey));
    });

    it("masks secrets in tool errors", async () => {
      const server = new MCPServer(createClient());
      (server as any).client.claim = async () => {
        throw new Error("failed with alv_cc_leaked9");
      };
      const result = await call(server, "allevitas_claim", { code: "alv_cc_x" });
      assert.equal(result.isError, true);
      assert.ok(!result.content[0].text.includes("alv_cc_leaked9"));
    });
  });

  describe("OS keyring", () => {
    it("keeps keys in the keyring and only a marker in the file", async () => {
      seedStore();
      const keyring = new FakeKeyring();
      const client = createClient({ keyring });
      await client.rotate();

      const raw = fs.readFileSync(credPath, "utf-8");
      assert.ok(!raw.includes("alv_sk_"));
      assert.equal(JSON.parse(raw).keyStorage, "keyring");
      assert.equal(keyring.entries.size, 1);
      const [account] = keyring.entries.keys();
      assert.equal(account, `${new URL(mock.url).host}/key_bot`);

      await createClient({ keyring }).getProfile();
      assert.equal(mock.state.keys.get(keyring.entries.get(account)!), "active");
    });

    it("falls back to the file when the keyring rejects a write", async () => {
      seedStore();
      const keyring = new FakeKeyring();
      keyring.failWrites = true;
      await createClient({ keyring }).rotate();
      assert.match(readCredentials().agentKey, /^alv_sk_/);
    });

    it("falls back when the keyring does not return what was stored", () => {
      const keyring = new FakeKeyring();
      keyring.get = () => "something else";
      assert.equal(storeInKeyring(keyring, "a", "alv_sk_x"), false);
    });

    it("does not overwrite the store when the keyring is locked", async () => {
      writeCredentials({ accountId: "key_bot", keyStorage: "keyring", token: "t", tokenExpiresAt: 1 });
      const before = fs.readFileSync(credPath, "utf-8");
      const client = createClient({ keyring: new FakeKeyring() });

      await assert.rejects(client.auth.getValidToken(), (err: any) => {
        assert.equal(err.code, "KEYRING_UNAVAILABLE");
        return true;
      });
      await client.auth.saveCredentials();

      assert.equal(fs.readFileSync(credPath, "utf-8"), before);
    });

    it("passes secrets to OS commands over stdin only", () => {
      for (const platform of ["darwin", "linux", "win32"]) {
        const calls: { command: string; args: string[]; input?: string }[] = [];
        const backend = createKeyringBackend(platform, (command, args, options) => {
          calls.push({ command, args, input: options?.input });
          return { status: 0, stdout: "" };
        })!;

        assert.equal(backend.set("host/bot", "alv_sk_commandline"), true);

        assert.ok(calls[0].input?.includes("alv_sk_commandline"), platform);
        assert.ok(!calls[0].args.join(" ").includes("alv_sk_commandline"), platform);
      }
    });

    it("returns no backend on an unsupported OS", () => {
      assert.equal(createKeyringBackend("aix"), null);
    });

    it("reads back trimmed values and treats failures as missing", () => {
      const backend = createKeyringBackend("linux", () => ({ status: 0, stdout: "alv_sk_x\n" }))!;
      assert.equal(backend.get("a"), "alv_sk_x");
      const failing = createKeyringBackend("linux", () => ({ status: 1, stdout: "" }))!;
      assert.equal(failing.get("a"), null);
      assert.equal(failing.set("a", "b"), false);
    });

    it("rejects values that are unsafe for the command channel", () => {
      assert.equal(storeInKeyring(new FakeKeyring(), "a", 'x" -w "y'), false);
    });
  });

  describe("credential file handling", () => {
    it("tightens a credentials file readable by others", { skip: process.platform === "win32" }, () => {
      seedStore();
      fs.chmodSync(credPath, 0o644);
      createClient();
      assert.equal(fs.statSync(credPath).mode & 0o777, 0o600);
      assert.match(stderrOutput(), /permissions were changed to 0600/);
    });

    it("writes atomically and leaves no temporary file behind", () => {
      writeFileAtomic(credPath, "first");
      writeFileAtomic(credPath, "second");
      assert.equal(fs.readFileSync(credPath, "utf-8"), "second");
      assert.deepEqual(fs.readdirSync(tmpDir), ["credentials.json"]);
    });

    it("keeps the old content when the rename fails", () => {
      fs.mkdirSync(credPath);
      assert.throws(() => writeFileAtomic(credPath, "new"));
      assert.deepEqual(fs.readdirSync(tmpDir), ["credentials.json"]);
    });

    it("serializes holders of the lock and removes it afterwards", async () => {
      const order: string[] = [];
      await Promise.all([
        withFileLock(credPath, async () => {
          order.push("a-start");
          await new Promise((resolve) => setTimeout(resolve, 150));
          order.push("a-end");
        }),
        withFileLock(credPath, async () => {
          order.push("b");
        }),
      ]);
      assert.deepEqual(order, ["a-start", "a-end", "b"]);
      assert.equal(fs.existsSync(`${credPath}.lock`), false);
    });

    it("gives up on a held lock and takes over a stale one", async () => {
      const lockPath = `${credPath}.lock`;
      fs.closeSync(fs.openSync(lockPath, "w"));
      assert.equal(await withFileLock(credPath, async () => 1, 0), null);

      const old = new Date(Date.now() - 2 * 60 * 1000);
      fs.utimesSync(lockPath, old, old);
      assert.deepEqual(await withFileLock(credPath, async () => 1, 0), { result: 1 });
    });
  });

  describe("CLI", () => {
    const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

    function runCli(
      args: string[],
      { input, env: extraEnv = {} }: { input?: string; env?: Record<string, string> } = {}
    ): Promise<{ code: number | null; stdout: string; stderr: string }> {
      // Empty values also keep a developer's .env from filling these in
      const blank = Object.fromEntries(ENV_KEYS.map((key) => [key, ""]));
      const env: NodeJS.ProcessEnv = { ...process.env, ...blank, ALLEVITAS_KEYRING: "off", ...extraEnv };
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", ...args, "--api-url", mock.url, "--credentials", credPath],
        { env, cwd: packageRoot, stdio: ["pipe", "pipe", "pipe"] }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.stdin.end(input ?? "");
      return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
    }

    const seedRecovery = (format: string, recoveryKey: string) => {
      seedStore();
      fs.writeFileSync(
        recoveryPath,
        JSON.stringify({ accountId: "key_bot", recoveryKey, recoveryKeyId: "currentrkid0", format, createdAt: "2026-11-01" })
      );
    };

    it("explains that --password and login are gone", async () => {
      const withFlag = await runCli(["post", "--password", "x"]);
      assert.equal(withFlag.code, 1);
      assert.match(withFlag.stderr, /--password is no longer supported/);

      const login = await runCli(["login"]);
      assert.equal(login.code, 1);
      assert.match(login.stderr, /allevitas migrate/);
    });

    it("has no way to pass the agent key as an argument", async () => {
      for (const args of [["--agent-key", "alv_sk_argument"], ["--agent-key=alv_sk_argument"]]) {
        const result = await runCli(["whoami", ...args]);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /Use ALLEVITAS_AGENT_KEY or --agent-key-stdin/);
        assert.ok(!result.stderr.includes("alv_sk_"));
      }
    });

    it("masks secrets in argument parsing errors", async () => {
      const result = await runCli(["whoami", "--alv_sk_argument"]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Failed to parse command line arguments/);
      assert.ok(!result.stderr.includes("alv_sk_"));
    });

    it("--agent-key-stdin saves the key and rejects other input", async () => {
      mock.state.keys.set("alv_sk_pipedkeyvalue", "active");
      const ok = await runCli(["key", "list", "--agent-key-stdin"], { input: "alv_sk_pipedkeyvalue\n" });
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(readCredentials().agentKey, "alv_sk_pipedkeyvalue");
      assert.ok(!ok.stdout.includes("alv_sk_pipedkeyvalue"));

      const bad = await runCli(["whoami", "--agent-key-stdin"], { input: "something else" });
      assert.equal(bad.code, 1);
    });

    it("rotates a key read from stdin and saves the new key", async () => {
      mock.state.keys.set("alv_sk_cikeyvalue001", "active");
      const result = await runCli(["key", "rotate", "--now", "--agent-key-stdin"], { input: "alv_sk_cikeyvalue001\n" });
      assert.equal(result.code, 0, result.stderr);
      const saved = readCredentials();
      assert.equal(mock.state.keys.get("alv_sk_cikeyvalue001"), "ROTATED");
      assert.equal(mock.state.keys.get(saved.agentKey), "active");
      assert.equal(saved.accountId, "key_bot");
    });

    it("whoami shows no secret", async () => {
      seedRecovery("alv_rk", "alv_rk_value");
      const result = await runCli(["whoami"]);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes("alv_sk_storedke..."));
      assert.ok(!result.stdout.includes("alv_sk_storedkeyvalue"));
      assert.ok(!result.stdout.includes("alv_rk_value"));
    });

    it("whoami shows only the prefix of a full-length key", async () => {
      const key = `alv_sk_${"a".repeat(43)}`;
      mock.state.keys.set(key, "active");
      writeCredentials({ accountId: "key_bot", agentKey: key, keyCreatedAt: Date.now() });
      const result = await runCli(["whoami"]);
      assert.ok(!result.stdout.includes(key));
      assert.ok(result.stdout.includes(key.slice(0, 15)));
    });

    it("migrate reads the password from stdin", async () => {
      mock.state.password = "OldPass123";
      const result = await runCli(["migrate", "--account-id", "key_bot", "--password-stdin"], { input: "OldPass123\n" });
      assert.equal(result.code, 0, result.stderr);
      assert.match(readCredentials().agentKey, /^alv_sk_/);
      assert.ok(!result.stdout.includes("alv_sk_"));
    });

    it("migrate reads ALLEVITAS_PASSWORD", async () => {
      mock.state.password = "OldPass123";
      const result = await runCli(["migrate", "--account-id", "key_bot"], { env: { ALLEVITAS_PASSWORD: "OldPass123" } });
      assert.equal(result.code, 0, result.stderr);
    });

    it("key rotate --now commits and revokes tokens", async () => {
      seedStore();
      const result = await runCli(["key", "rotate", "--now"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(mock.state.tokenVersion, 1);
      assert.ok(!result.stdout.includes(readCredentials().agentKey));
    });

    it("key claim reads the code from stdin", async () => {
      mock.state.claimCodes.set("alv_cc_good", "unused");
      const result = await runCli(["key", "claim"], { input: "alv_cc_good\n" });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(!result.stdout.includes(readCredentials().agentKey));
    });

    it("key claim explains a used code and exits with the auth code", async () => {
      mock.state.claimCodes.set("alv_cc_used", "used");
      const result = await runCli(["key", "claim"], { input: "alv_cc_used\n" });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /stolen/);
      assert.ok(!result.stderr.includes("alv_cc_used"));
    });

    it("recovery-key export refuses without a terminal or a flag", async () => {
      seedRecovery("alv_rk", "alv_rk_value");
      const result = await runCli(["recovery-key", "export"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--non-interactive/);
      assert.ok(!result.stdout.includes("alv_rk_value"));
      assert.ok(fs.existsSync(recoveryPath));
    });

    it("--non-interactive writes exactly the value to stdout and keeps the file", async () => {
      seedRecovery("alv_rk", "alv_rk_value");
      const result = await runCli(["recovery-key", "export", "--non-interactive"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "alv_rk_value");
      assert.ok(fs.existsSync(recoveryPath));
    });

    it("--non-interactive --delete removes the file after the output", async () => {
      seedRecovery("alv_rk", "alv_rk_value");
      const result = await runCli(["recovery-key", "export", "--non-interactive", "--delete"]);
      assert.equal(result.stdout, "alv_rk_value");
      assert.equal(fs.existsSync(recoveryPath), false);
    });

    it("recommends renewing a legacy key on stderr only", async () => {
      seedRecovery("legacy_rc", "RC-00000000aaaaaaaa");
      const result = await runCli(["recovery-key", "export", "--non-interactive"]);
      assert.equal(result.stdout, "RC-00000000aaaaaaaa");
      assert.match(result.stderr, /legacy recovery key/);
    });

    it("recovery-key delete shows no value and works without a terminal", async () => {
      seedRecovery("alv_rk", "alv_rk_value");
      const result = await runCli(["recovery-key", "delete"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(fs.existsSync(recoveryPath), false);
      assert.ok(!(result.stdout + result.stderr).includes("alv_rk_value"));
    });

    it("recovery-key reports when nothing is stored", async () => {
      seedStore();
      for (const action of ["export", "delete"]) {
        const result = await runCli(["recovery-key", action]);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stderr, /No recovery key is stored/);
      }
    });
  });
});
