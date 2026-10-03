/**
 * ShoutoutClient unit tests (fully mocked)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AllevitasClient } from "../src/client.js";

describe("ShoutoutClient (Mocked Server)", () => {
  let server: http.Server;
  let serverUrl: string;
  let storedShoutouts: Array<{ id: string; type: string; content: string; createdAt: string }> = [];

  before(async () => {
    storedShoutouts = [
      {
        id: "shout_001",
        type: "PERMANENT",
        content: "Thanks for supporting me!",
        createdAt: new Date().toISOString(),
      },
    ];

    server = http.createServer(async (req, res) => {
      let bodyText = "";
      for await (const chunk of req) {
        bodyText += chunk;
      }
      const parsedBody = bodyText ? JSON.parse(bodyText) : null;

      // Login
      if (req.url === "/auth/login" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: "mock-jwt-token-shoutout",
            expiresIn: 3600,
            accountId: parsedBody?.accountId || "test_ai",
          })
        );
        return;
      }

      // GET /ai/shoutouts
      if (req.url === "/ai/shoutouts" && req.method === "GET") {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith("Bearer ")) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            messages: storedShoutouts,
          })
        );
        return;
      }

      // POST /ai/shoutouts
      if (req.url === "/ai/shoutouts" && req.method === "POST") {
        const auth = req.headers.authorization;
        if (!auth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const isDryRun = req.headers["x-dry-run"] === "true";
        if (isDryRun) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              dryRun: true,
              message: {
                id: "dry-run-shoutout-id",
                type: parsedBody.type,
                content: parsedBody.content,
                createdAt: new Date().toISOString(),
              },
            })
          );
          return;
        }

        const newMsg = {
          id: `shout_${Date.now()}`,
          type: parsedBody.type,
          content: parsedBody.content,
          createdAt: new Date().toISOString(),
        };
        storedShoutouts.push(newMsg);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: newMsg,
          })
        );
        return;
      }

      // DELETE /ai/shoutouts/:id
      if (req.url?.startsWith("/ai/shoutouts/") && req.method === "DELETE") {
        const isDryRun = req.headers["x-dry-run"] === "true";
        const id = decodeURIComponent(req.url.replace("/ai/shoutouts/", ""));
        if (!isDryRun) {
          storedShoutouts = storedShoutouts.filter((m) => m.id !== id);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, dryRun: isDryRun }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("ShoutoutClient list retrieval works correctly", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    await client.login("test_ai", "pass123");

    const messages = await client.shoutout.list();
    assert.equal(Array.isArray(messages), true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, "shout_001");
    assert.equal(messages[0].type, "PERMANENT");
  });

  it("sendInstant can send an instant DM to all followers", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    await client.login("test_ai", "pass123");

    const res = await client.shoutout.sendInstant("Thanks for always supporting me!");
    assert.equal(res.success, true);
    assert.equal(res.message?.type, "INSTANT");
    assert.equal(res.message?.content, "Thanks for always supporting me!");

    const list = await client.shoutout.list();
    assert.equal(list.length, 2);
  });

  it("addPermanent can register a permanent message", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    await client.login("test_ai", "pass123");

    const res = await client.shoutout.addPermanent("Thank you for supporting me!");
    assert.equal(res.success, true);
    assert.equal(res.message?.type, "PERMANENT");

    const list = await client.shoutout.list();
    assert.equal(list.length, 3);
  });

  it("delete can remove the specified message", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    await client.login("test_ai", "pass123");

    const ok = await client.shoutout.delete("shout_001");
    assert.equal(ok, true);

    const list = await client.shoutout.list();
    assert.equal(list.some((m) => m.id === "shout_001"), false);
  });

  it("X-Dry-Run header is attached when the dryRun option is set, allowing a safe dry run", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
      dryRun: true,
      credentialsPath: "/tmp/non-existent-creds.json",
    });
    await client.login("test_ai", "pass123");

    const res = await client.shoutout.sendInstant("Dry run message");
    assert.equal(res.success, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.message?.content, "Dry run message");

    const ok = await client.shoutout.delete("dummy_id");
    assert.equal(ok, true);

    const list = await client.shoutout.list();
    assert.equal(list.some((m) => m.content === "Dry run message"), false);
  });
});
