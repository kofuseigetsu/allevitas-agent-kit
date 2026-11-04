/**
 * Secret delivery tests: one-time links from the server, recovery key files, and secretDelivery "url" (no API key required, uses a mock server)
 */

import "./helpers/testEnv.js";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AllevitasClient, ClientOptions, maskSecrets } from "../src/index.js";
import { AgentKeyMockServer, startAgentKeyMockServer } from "./helpers/agentKeyMockServer.js";

const ENV_KEYS = [
  "ALLEVITAS_AGENT_KEY",
  "ALLEVITAS_RECOVERY_KEY_FILE",
  "ALLEVITAS_SAVE_CREDENTIALS",
  "ALLEVITAS_NO_SAVE_CREDENTIALS",
  "ALLEVITAS_DRY_RUN",
  "ALLEVITAS_SECRET_DELIVERY",
];

describe("Secret delivery", () => {
  let mock: AgentKeyMockServer;
  let tmpDir: string;
  let credPath: string;
  let recoveryPath: string;
  let stderrLines: string[];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const savedEnv: Record<string, string | undefined> = {};

  const createClient = (options: ClientOptions = {}) => {
    const client = new AllevitasClient({ apiUrl: mock.url, credentialsPath: credPath, keyring: false, maxRetries: 0, ...options });
    (client.auth as any).challengeSolver = {
      fetchChallenge: async () => ({ id: "c1", puzzleType: "LOG_FILTERING", prompt: "p", expiresAt: Date.now() + 30000 }),
      solve: async () => ({ matchCount: 1, totalBytes: 1, targetIds: [] }),
      getReflectionKnowledge: () => [],
    };
    return client;
  };
  const readCredentials = () => JSON.parse(fs.readFileSync(credPath, "utf-8"));
  const seedStore = () => {
    mock.state.keys.set("alv_sk_storedkeyvalue", "active");
    fs.writeFileSync(credPath, JSON.stringify({ accountId: "key_bot", agentKey: "alv_sk_storedkeyvalue", keyCreatedAt: Date.now() }), { mode: 0o600 });
  };

  before(async () => {
    mock = await startAgentKeyMockServer();
  });

  after(async () => {
    await mock.close();
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "allevitas-secret-delivery-"));
    credPath = path.join(tmpDir, "credentials.json");
    recoveryPath = path.join(tmpDir, "key_bot.recovery-key.json");
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    Object.assign(mock.state, {
      password: null,
      recoveryKeyId: "currentrkid0",
      tokenVersion: 0,
      failTokenRequests: 0,
      nextApiError: null,
      ignoreSecretDelivery: false,
      linkRecoveryKey: false,
      secretDeliveryError: null,
    });
    for (const list of [mock.state.tokenRequests, mock.state.registerRequests, mock.state.forwardedFor, mock.state.apiAuthorizations]) {
      list.length = 0;
    }
    mock.state.keys.clear();
    mock.state.claimCodes.clear();
    mock.state.links.clear();

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

  describe("recovery key on a normal registration", () => {
    it("uses the server's link and writes no file", async () => {
      mock.state.linkRecoveryKey = true;
      const res = await createClient().register("key_bot");

      assert.equal(mock.state.links.get(res.recoveryKeyUrl!), "alv_rk_registered");
      assert.equal(res.recoveryKeyUrlExpiresAt, "2026-11-04T00:00:00.000Z");
      assert.equal(res.recoveryKeyFile, undefined);
      assert.equal(fs.existsSync(recoveryPath), false);
      assert.match(readCredentials().agentKey, /^alv_sk_/);
      assert.equal(mock.state.registerRequests[0].secretDelivery, undefined);
    });

    it("writes a file when the server sends no link", async () => {
      const res = await createClient().register("key_bot");

      assert.equal(res.recoveryKeyUrl, undefined);
      assert.equal(res.recoveryKeyFile, recoveryPath);
      assert.equal(JSON.parse(fs.readFileSync(recoveryPath, "utf-8")).recoveryKey, "alv_rk_registered");
    });
  });

  describe("secretDelivery url", () => {
    it("rejects an unknown ALLEVITAS_SECRET_DELIVERY value", () => {
      process.env.ALLEVITAS_SECRET_DELIVERY = "email";
      assert.throws(() => createClient(), /must be "url"/);
    });

    it("registers with links only and saves nothing, even where credentials could be saved", async () => {
      const client = createClient({ secretDelivery: "url" });
      const res = await client.register("key_bot");

      assert.equal(mock.state.registerRequests[0].secretDelivery, "url");
      assert.ok(res.agentKeyUrl && res.recoveryKeyUrl);
      assert.ok(!JSON.stringify(res).includes("alv_sk_"));
      assert.equal(fs.existsSync(credPath), false);
      assert.equal(fs.existsSync(recoveryPath), false);
    });

    it("checks in a dry run that the server supports links", async () => {
      const ok = await createClient({ secretDelivery: "url" }).register("key_bot", undefined, undefined, { dryRun: true });
      assert.equal(ok.dryRun, true);

      mock.state.ignoreSecretDelivery = true;
      await assert.rejects(
        createClient({ secretDelivery: "url" }).register("key_bot", undefined, undefined, { dryRun: true }),
        (err: any) => {
          assert.equal(err.code, "SECRET_DELIVERY_UNSUPPORTED");
          return true;
        }
      );
    });

    it("stops when an old server returns raw keys", async () => {
      mock.state.ignoreSecretDelivery = true;
      await assert.rejects(createClient({ secretDelivery: "url" }).register("key_bot"), (err: any) => {
        assert.equal(err.code, "SECRET_DELIVERY_UNSUPPORTED");
        assert.ok(!err.message.includes("alv_sk_"));
        return true;
      });
    });

    it("does not retry a failed link and reports that no account was created", async () => {
      mock.state.secretDeliveryError = "FAILED";
      await assert.rejects(createClient({ secretDelivery: "url", maxRetries: 3, baseDelayMs: 1 }).register("key_bot"), (err: any) => {
        assert.equal(err.code, "SECRET_DELIVERY_FAILED");
        assert.match(err.message, /No account was created/);
        return true;
      });
      assert.equal(mock.state.registerRequests.length, 1);
    });

    it("retries when links are temporarily unavailable", async () => {
      mock.state.secretDeliveryError = "UNAVAILABLE";
      const client = createClient({ secretDelivery: "url", maxRetries: 2, baseDelayMs: 1 });
      (client.auth as any).rateLimitHandler.onRetry = () => {};
      const res = await client.register("key_bot");
      assert.ok(res.agentKeyUrl);
      assert.equal(mock.state.registerRequests.length, 2);
    });

    it("rotates without committing: the old key stays valid until the new one is used", async () => {
      seedStore();
      const res = await createClient({ secretDelivery: "url" }).rotate();

      assert.equal(res.rotated, true);
      assert.equal(res.committed, false);
      const newKey = mock.state.links.get(res.agentKeyUrl!)!;
      assert.equal(mock.state.keys.get(newKey), "pending");
      assert.equal(mock.state.keys.get("alv_sk_storedkeyvalue"), "active");
      assert.equal(readCredentials().pendingAgentKey, undefined);
      assert.equal(mock.state.tokenRequests.filter((r) => r.agentKey === newKey).length, 0);
    });

    it("refuses rotateNow before sending anything", async () => {
      seedStore();
      await assert.rejects(createClient({ secretDelivery: "url" }).rotateNow(), (err: any) => {
        assert.equal(err.code, "ROTATE_NOW_UNAVAILABLE");
        assert.match(err.message, /recover/);
        return true;
      });
      assert.equal(mock.state.tokenRequests.length, 0);
    });

    it("keeps the current key when the rotation link fails", async () => {
      seedStore();
      mock.state.secretDeliveryError = "FAILED";
      await assert.rejects(createClient({ secretDelivery: "url" }).rotate(), (err: any) => {
        assert.equal(err.code, "SECRET_DELIVERY_FAILED");
        assert.match(err.message, /still valid/);
        return true;
      });
      assert.equal(mock.state.keys.get("alv_sk_storedkeyvalue"), "active");
    });

    it("claim tells the operator to recover again when the link fails", async () => {
      mock.state.claimCodes.set("alv_cc_good", "unused");
      mock.state.secretDeliveryError = "FAILED";
      await assert.rejects(createClient({ secretDelivery: "url" }).claim("alv_cc_good"), (err: any) => {
        assert.equal(err.code, "SECRET_DELIVERY_FAILED");
        assert.match(err.message, /recover\/agent/);
        return true;
      });
    });

    it("never rotates automatically", async () => {
      mock.state.keys.set("alv_sk_storedkeyvalue", "active");
      fs.writeFileSync(credPath, JSON.stringify({ accountId: "key_bot", agentKey: "alv_sk_storedkeyvalue", keyCreatedAt: 0 }));
      await createClient({ secretDelivery: "url" }).getProfile();
      assert.equal(mock.state.tokenRequests.some((r) => r.rotate), false);
    });

    it("reports the mode in the status", () => {
      assert.equal(createClient({ secretDelivery: "url" }).auth.getStatus().secretDelivery, "url");
      assert.equal(createClient().auth.getStatus().secretDelivery, null);
      assert.equal(createClient({ saveCredentials: false }).auth.getStatus().secretDelivery, "url");
    });
  });

  describe("HTTP layer", () => {
    it("sends the forwarded client IP and extra headers to the API", async () => {
      seedStore();
      const seen: Headers[] = [];
      let ip = "203.0.113.7";
      const client = createClient({
        forwardedFor: () => ip,
        extraHeaders: { "X-Internal-Secret": "internal" },
        fetch: (input, init) => {
          seen.push(new Headers(init?.headers));
          return fetch(input, init);
        },
      });
      await client.getProfile();
      ip = "198.51.100.2";
      await client.getProfile();

      assert.deepEqual(mock.state.forwardedFor.slice(-2), ["203.0.113.7", "198.51.100.2"]);
      assert.ok(seen.every((h) => h.get("x-internal-secret") === "internal" && h.get("user-agent")));
    });
  });

  describe("masking", () => {
    it("masks the fragment of a link but keeps the rest", () => {
      assert.equal(
        maskSecrets("open https://allevitas.com/secrets/abc#k3y-value now"),
        "open https://allevitas.com/secrets/abc#[FILTERED] now"
      );
    });
  });
});
