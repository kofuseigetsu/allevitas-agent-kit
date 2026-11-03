/**
 * Secret delivery tests: one-time links from the server, SecretStoreProvider fallback,
 * recovery key files, and secretDelivery "url" (no API key required, uses a mock server)
 */

import "./helpers/testEnv.js";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AllevitasClient, ClientOptions, maskSecrets, SecretStoreProvider } from "../src/index.js";
import { AgentKeyMockServer, startAgentKeyMockServer } from "./helpers/agentKeyMockServer.js";

const ENV_KEYS = [
  "ALLEVITAS_AGENT_KEY",
  "ALLEVITAS_RECOVERY_KEY_FILE",
  "ALLEVITAS_SAVE_CREDENTIALS",
  "ALLEVITAS_NO_SAVE_CREDENTIALS",
  "ALLEVITAS_DRY_RUN",
  "ALLEVITAS_SECRET_DELIVERY",
  "ALLEVITAS_SECRET_STORE_MODULE",
  "ALLEVITAS_SECRET_STORE_TTL",
  "ALLEVITAS_SECRET_STORE_OPT_BASE_URL",
  "ALLEVITAS_SECRET_STORE_OPT_API_TOKEN",
];

class MemoryStore implements SecretStoreProvider {
  name = "memory";
  stored: { secret: string; ttlSec: number; kind: string }[] = [];
  reachable = true;
  failures = 0;
  async check() {
    return this.reachable;
  }
  async store(secret: string, opts: { ttlSec: number; kind: "recovery_key" | "agent_key" }) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("store unavailable");
    }
    this.stored.push({ secret, ...opts });
    return { url: `https://store.example/s/${this.stored.length}#pw${this.stored.length}`, expiresAt: "2026-11-05T00:00:00.000Z" };
  }
}

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
  const stderrOutput = () => stderrLines.join("");

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
    it("uses the server's link and writes no file, without asking the store", async () => {
      mock.state.linkRecoveryKey = true;
      const store = new MemoryStore();
      const res = await createClient({ secretStore: store }).register("key_bot");

      assert.equal(mock.state.links.get(res.recoveryKeyUrl!), "alv_rk_registered");
      assert.equal(res.recoveryKeyUrlExpiresAt, "2026-11-04T00:00:00.000Z");
      assert.equal(res.recoveryKeyFile, undefined);
      assert.equal(fs.existsSync(recoveryPath), false);
      assert.equal(store.stored.length, 0);
      assert.match(readCredentials().agentKey, /^alv_sk_/);
      assert.equal(mock.state.registerRequests[0].secretDelivery, undefined);
    });

    it("uses the store when the server sends no link", async () => {
      const store = new MemoryStore();
      process.env.ALLEVITAS_SECRET_STORE_TTL = "3600";
      const res = await createClient({ secretStore: store }).register("key_bot");

      assert.deepEqual(store.stored, [{ secret: "alv_rk_registered", ttlSec: 3600, kind: "recovery_key" }]);
      assert.equal(res.recoveryKeyUrl, "https://store.example/s/1#pw1");
      assert.equal(fs.existsSync(recoveryPath), false);
    });

    it("falls back to a file when the store fails its check", async () => {
      const store = new MemoryStore();
      store.reachable = false;
      const res = await createClient({ secretStore: store }).register("key_bot");

      assert.equal(res.recoveryKeyUrl, undefined);
      assert.equal(res.recoveryKeyFile, recoveryPath);
      assert.equal(store.stored.length, 0);
      assert.match(stderrOutput(), /not reachable/);
    });

    it("falls back to a file when the store keeps failing", async () => {
      const store = new MemoryStore();
      store.failures = 3;
      const res = await createClient({ secretStore: store }).register("key_bot");

      assert.equal(res.recoveryKeyFile, recoveryPath);
      assert.equal(JSON.parse(fs.readFileSync(recoveryPath, "utf-8")).recoveryKey, "alv_rk_registered");
      assert.match(stderrOutput(), /saved to a file instead/);
    });

    it("refuses a store together with an explicit recovery key file, before creating the account", async () => {
      process.env.ALLEVITAS_RECOVERY_KEY_FILE = path.join(tmpDir, "rk.json");
      await assert.rejects(createClient({ secretStore: new MemoryStore() }).register("key_bot"), (err: any) => {
        assert.equal(err.code, "CONFIG_CONFLICT");
        return true;
      });
      assert.equal(mock.state.registerRequests.length, 0);
    });
  });

  describe("secret store module", () => {
    const writeModule = (body: string) => {
      const file = path.join(tmpDir, "provider.mjs");
      fs.writeFileSync(file, body);
      return file;
    };

    it("loads the factory and passes the TTL and options from the environment", async () => {
      process.env.ALLEVITAS_SECRET_STORE_MODULE = writeModule(`
        export default (config) => ({
          name: "file-module",
          async store(secret, opts) {
            return { url: config.options.baseUrl + "/x#" + opts.ttlSec + "-" + config.options.apiToken.length };
          },
        });
      `);
      process.env.ALLEVITAS_SECRET_STORE_OPT_BASE_URL = "https://module.example";
      process.env.ALLEVITAS_SECRET_STORE_OPT_API_TOKEN = "token-value-123456";
      process.env.ALLEVITAS_SECRET_STORE_TTL = "600";

      const res = await createClient().register("key_bot");

      assert.equal(res.recoveryKeyUrl, "https://module.example/x#600-18");
      assert.equal(maskSecrets("auth token-value-123456"), "auth [FILTERED]");
    });

    it("fails with CONFIG_ERROR when the module cannot be used", async () => {
      process.env.ALLEVITAS_SECRET_STORE_MODULE = writeModule("export const nothing = 1;");
      await assert.rejects(createClient().register("key_bot"), (err: any) => {
        assert.equal(err.code, "CONFIG_ERROR");
        return true;
      });
      assert.equal(mock.state.registerRequests.length, 0);
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

    it("stops when an old server returns raw keys and no store is configured", async () => {
      mock.state.ignoreSecretDelivery = true;
      await assert.rejects(createClient({ secretDelivery: "url" }).register("key_bot"), (err: any) => {
        assert.equal(err.code, "SECRET_DELIVERY_UNSUPPORTED");
        assert.ok(!err.message.includes("alv_sk_"));
        return true;
      });
    });

    it("puts raw keys from an old server into the store", async () => {
      mock.state.ignoreSecretDelivery = true;
      const store = new MemoryStore();
      const res = await createClient({ secretDelivery: "url", secretStore: store }).register("key_bot");

      assert.deepEqual(store.stored.map((s) => s.kind), ["agent_key", "recovery_key"]);
      assert.match(store.stored[0].secret, /^alv_sk_/);
      assert.equal(res.agentKeyUrl, "https://store.example/s/1#pw1");
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
