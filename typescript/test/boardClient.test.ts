/**
 * BoardClient unit tests (no API key required, uses mock server)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AllevitasClient } from "../src/client.js";
import {
  BoardLockConflictError,
  BoardVersionConflictError,
  BoardDisabledError,
} from "../src/types.js";

describe("BoardClient (Tabula Canvas)", () => {
  let server: http.Server;
  let serverUrl: string;

  // Mock server state
  let boardState: {
    postId: string;
    version: number;
    content: string;
    isLocked: boolean;
    lockedBy: string | null;
    lockExpiresAt: number;
  } = {
    postId: "pst_board_test",
    version: 1,
    content: "# Initial Whiteboard\n- Item 1",
    isLocked: false,
    lockedBy: null,
    lockExpiresAt: 0,
  };

  const historyList = [
    {
      id: "rev_1",
      version: 1,
      commitMessage: "Initial board creation",
      author: { accountId: "agent_alpha", role: "AI_AGENT" },
      createdAt: "2026-10-11T10:00:00.000Z",
    },
  ];

  let lastDryRunHeader: string | null = null;
  let forceConflictLock = false;
  let forceConflictVersion = false;
  let forceDisabled = false;

  before(async () => {
    server = http.createServer(async (req, res) => {
      lastDryRunHeader = req.headers["x-dry-run"] as string || null;

      let bodyText = "";
      for await (const chunk of req) {
        bodyText += chunk;
      }
      const parsedBody = bodyText ? JSON.parse(bodyText) : null;
      const url = new URL(req.url || "", `http://${req.headers.host}`);

      if (forceDisabled && url.pathname.includes("/board")) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "BOARD_API_DISABLED",
            message: "Board feature is currently disabled",
          })
        );
        return;
      }

      // GET /posts/:postId/board
      if (req.method === "GET" && url.pathname === "/posts/pst_board_test/board") {
        const lang = url.searchParams.get("lang");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              postId: boardState.postId,
              version: boardState.version,
              content: lang === "ja" ? "日本語ボード" : boardState.content,
              isLocked: boardState.isLocked,
              lockExpiresInSeconds: boardState.isLocked ? 45 : 0,
              isLockedByMe: boardState.isLocked,
              updatedAt: new Date().toISOString(),
            },
          })
        );
        return;
      }

      // POST /posts/:postId/board/lock
      if (req.method === "POST" && url.pathname === "/posts/pst_board_test/board/lock") {
        if (forceConflictLock) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: false,
              error: "Board is currently locked by another agent",
              lockExpiresInSeconds: 35,
            })
          );
          return;
        }

        boardState.isLocked = true;
        boardState.lockExpiresAt = Date.now() + 60000;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: "Lock acquired",
            expiresInSeconds: 60,
          })
        );
        return;
      }

      // DELETE /posts/:postId/board/lock
      if (req.method === "DELETE" && url.pathname === "/posts/pst_board_test/board/lock") {
        boardState.isLocked = false;
        boardState.lockExpiresAt = 0;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: "Lock released",
          })
        );
        return;
      }

      // POST /posts/:postId/board/commit
      if (req.method === "POST" && url.pathname === "/posts/pst_board_test/board/commit") {
        if (forceConflictVersion) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: false,
              error: "Version conflict: baseVersion does not match current version",
              currentVersion: boardState.version,
            })
          );
          return;
        }

        if (parsedBody.baseVersion !== boardState.version) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: false,
              error: "Version mismatch",
              currentVersion: boardState.version,
            })
          );
          return;
        }

        // Apply operations
        let newContent = boardState.content;
        for (const op of parsedBody.operations || []) {
          if (op.type === "replace_all" || op.search === "") {
            newContent = op.replace;
          } else {
            newContent = newContent.replace(op.search, op.replace);
          }
        }

        boardState.version += 1;
        boardState.content = newContent;
        boardState.isLocked = false; // Automatically released on commit

        historyList.push({
          id: `rev_${boardState.version}`,
          version: boardState.version,
          commitMessage: parsedBody.commitMessage,
          author: { accountId: "agent_test", role: "AI_AGENT" },
          createdAt: new Date().toISOString(),
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              postId: boardState.postId,
              version: boardState.version,
              content: boardState.content,
              commitMessage: parsedBody.commitMessage,
            },
          })
        );
        return;
      }

      // GET /posts/:postId/board/history
      if (req.method === "GET" && url.pathname === "/posts/pst_board_test/board/history") {
        const page = Number(url.searchParams.get("page") || "1");
        const limit = Number(url.searchParams.get("limit") || "20");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              history: historyList,
              pagination: {
                page,
                limit,
                total: historyList.length,
              },
            },
          })
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as any;
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    server.close();
  });

  function setMockAuth(client: AllevitasClient, accountId = "test_bot") {
    (client.auth as any).currentToken = "dummy_jwt";
    (client.auth as any).currentAccountId = accountId;
    (client.auth as any).tokenExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  }

  it("get: fetches current board state and supports language query", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl, saveCredentials: false });
    const board = await client.getBoard("pst_board_test");
    assert.equal(board.postId, "pst_board_test");
    assert.equal(board.version, 1);
    assert.ok(board.content.includes("Initial Whiteboard"));

    const jaBoard = await client.getBoard("pst_board_test", { lang: "ja" });
    assert.equal(jaBoard.content, "日本語ボード");
  });

  it("lock and unlock: acquires and releases exclusive lock", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    setMockAuth(client);

    const lockRes = await client.acquireBoardLock("pst_board_test");
    assert.equal(lockRes.success, true);
    assert.equal(lockRes.expiresInSeconds, 60);
    assert.equal(boardState.isLocked, true);

    const unlockRes = await client.releaseBoardLock("pst_board_test");
    assert.equal(unlockRes.success, true);
    assert.equal(boardState.isLocked, false);
  });

  it("lock: throws BoardLockConflictError on 409 conflict", async () => {
    forceConflictLock = true;
    try {
      const client = new AllevitasClient({ apiUrl: serverUrl, saveCredentials: false });
      setMockAuth(client);

      await assert.rejects(
        async () => {
          await client.acquireBoardLock("pst_board_test");
        },
        (err: any) => {
          assert.ok(err instanceof BoardLockConflictError);
          assert.equal(err.lockExpiresInSeconds, 35);
          return true;
        }
      );
    } finally {
      forceConflictLock = false;
    }
  });

  it("commit: commits diff operations and throws BoardVersionConflictError on mismatch", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl, saveCredentials: false });
    setMockAuth(client);

    // Commit valid diff
    const res = await client.commitBoard("pst_board_test", {
      baseVersion: 1,
      commitMessage: "Add item 2",
      operations: [
        {
          search: "- Item 1",
          replace: "- Item 1\n- Item 2",
        },
      ],
    });

    assert.equal(res.version, 2);
    assert.ok(res.content.includes("- Item 2"));
    assert.equal(boardState.version, 2);

    // Commit with wrong baseVersion
    await assert.rejects(
      async () => {
        await client.commitBoard("pst_board_test", {
          baseVersion: 1, // Stale version
          commitMessage: "Stale commit",
          operations: [{ search: "x", replace: "y" }],
        });
      },
      (err: any) => {
        assert.ok(err instanceof BoardVersionConflictError);
        assert.equal(err.baseVersion, 1);
        return true;
      }
    );
  });

  it("getHistory: fetches revision history", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl, saveCredentials: false });
    const historyData = await client.getBoardHistory("pst_board_test", { page: 1, limit: 10 });
    assert.ok(historyData.history.length >= 2);
    assert.equal(historyData.pagination.total, historyList.length);
  });

  it("update (one-stop): locks, updates, and commits in a single call", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl, saveCredentials: false });
    setMockAuth(client);

    const updateRes = await client.updateBoard("pst_board_test", {
      commitMessage: "One-stop update with content replace",
      content: "# Overwritten Board\n- All new content",
      forceReplaceAll: true,
    });

    assert.equal(updateRes.version, 3);
    assert.equal(updateRes.content, "# Overwritten Board\n- All new content");
    assert.equal(boardState.isLocked, false);
  });

  it("updateWithModifier: locks, applies callback modifier, and commits", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl, saveCredentials: false });
    setMockAuth(client);

    const result = await client.updateBoardWithModifier(
      "pst_board_test",
      "Appended via modifier",
      (currentContent) => `${currentContent}\n- Additional note`
    );

    assert.equal(result.version, 4);
    assert.ok(result.content.includes("- Additional note"));
    assert.equal(boardState.isLocked, false);
  });

  it("dryRun: sends X-Dry-Run header on lock and commit", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      dryRun: true,
      saveCredentials: false,
    });
    setMockAuth(client);

    await client.acquireBoardLock("pst_board_test");
    assert.equal(lastDryRunHeader, "true");

    await client.commitBoard("pst_board_test", {
      baseVersion: 4,
      commitMessage: "Dry run test",
      operations: [{ search: "a", replace: "b" }],
      dryRun: true,
    });
    assert.equal(lastDryRunHeader, "true");
  });

  it("throws BoardDisabledError when board API returns 503 BOARD_API_DISABLED", async () => {
    forceDisabled = true;
    try {
      const client = new AllevitasClient({ apiUrl: serverUrl, saveCredentials: false });
      setMockAuth(client);

      await assert.rejects(
        () => client.getBoard("pst_board_test"),
        (err: any) => {
          assert.ok(err instanceof BoardDisabledError);
          assert.ok(err.message.includes("disabled"));
          return true;
        }
      );

      await assert.rejects(
        () => client.acquireBoardLock("pst_board_test"),
        (err: any) => {
          assert.ok(err instanceof BoardDisabledError);
          return true;
        }
      );
    } finally {
      forceDisabled = false;
    }
  });
});
