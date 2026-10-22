/**
 * BoardClient.update / updateWithModifier tests
 * Covers the update matrix (F = forceReplaceAll, C = content, O = operations),
 * baseVersion, no-op results, dry-run handling, and lock release.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AllevitasClient } from "../src/client.js";
import { BoardVersionConflictError } from "../src/types.js";
import { startMockBoardServer, type MockBoardServer } from "./helpers/boardMockServer.js";

const POST_ID = "pst_board_update";
const INITIAL = "# Initial Whiteboard\n- Item 1";

describe("BoardClient.update matrix", () => {
  let mockServer: MockBoardServer;

  before(async () => {
    mockServer = await startMockBoardServer(POST_ID);
  });

  after(async () => {
    await mockServer.close();
  });

  beforeEach(() => {
    mockServer.reset(INITIAL);
  });

  function createClient(dryRun = false): AllevitasClient {
    const client = new AllevitasClient({ apiUrl: mockServer.url, dryRun, saveCredentials: false });
    (client.auth as any).currentToken = "dummy_jwt";
    (client.auth as any).currentAccountId = "test_bot";
    (client.auth as any).tokenExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    return client;
  }

  function assertReleasedWithoutCommit() {
    assert.equal(mockServer.state.commitCalls, 0);
    assert.equal(mockServer.state.unlockCalls, 1);
    assert.equal(mockServer.state.isLocked, false);
  }

  it("No.1: commits content as an automatic diff", async () => {
    const res = await createClient().updateBoard(POST_ID, {
      commitMessage: "Add item 2",
      content: `${INITIAL}\n- Item 2`,
    });
    assert.equal(res.changed, true);
    assert.equal(res.version, 2);
    assert.equal(res.content, `${INITIAL}\n- Item 2`);
    assert.equal(res.commitMessage, "Add item 2");
    assert.deepEqual(mockServer.state.lastOperations, [{ search: "- Item 1", replace: "- Item 1\n- Item 2" }]);
    assert.equal(mockServer.state.isLocked, false);
  });

  it("No.2: identical content (ignoring CRLF) is a no-op", async () => {
    const res = await createClient().updateBoard(POST_ID, {
      commitMessage: "No change",
      content: INITIAL.replace(/\n/g, "\r\n"),
    });
    assert.equal(res.changed, false);
    assert.equal(res.version, 1);
    assert.equal(res.postId, POST_ID);
    assert.equal(res.content, INITIAL);
    assert.equal(res.commitMessage, "No change");
    assertReleasedWithoutCommit();
  });

  it("No.3: a rejected diff throws without falling back to replace_all", async () => {
    mockServer.state.rejectNextCommit = "AMBIGUOUS_SEARCH_TARGET";
    await assert.rejects(() =>
      createClient().updateBoard(POST_ID, { commitMessage: "x", content: `${INITIAL}\n- Item 2` })
    );
    // Exactly one diff commit was attempted; no replace_all retry followed
    assert.equal(mockServer.state.commitCalls, 1);
    assert.ok(mockServer.state.lastOperations?.every((op: any) => op.type !== "replace_all"));
    assert.equal(mockServer.state.unlockCalls, 1);
    assert.equal(mockServer.state.content, INITIAL);
  });

  it("No.4: initial write to an empty board uses replace_all", async () => {
    mockServer.reset("");
    const res = await createClient().updateBoard(POST_ID, { commitMessage: "Init", content: "# New" });
    assert.equal(res.changed, true);
    assert.equal(res.content, "# New");
    assert.deepEqual(mockServer.state.lastOperations, [{ search: "", replace: "# New", type: "replace_all" }]);
  });

  it("No.5: empty content on an empty board is a no-op", async () => {
    mockServer.reset("");
    const res = await createClient().updateBoard(POST_ID, { commitMessage: "x", content: "" });
    assert.equal(res.changed, false);
    assertReleasedWithoutCommit();
  });

  it("No.6: clearing a non-empty board requires forceReplaceAll", async () => {
    await assert.rejects(() => createClient().updateBoard(POST_ID, { commitMessage: "x", content: "" }));
    assertReleasedWithoutCommit();
    assert.equal(mockServer.state.content, INITIAL);
  });

  it("No.7: operations are committed as-is", async () => {
    const operations = [{ search: "- Item 1", replace: "- Item 1 (done)" }];
    const res = await createClient().updateBoard(POST_ID, { commitMessage: "x", operations });
    assert.deepEqual(mockServer.state.lastOperations, operations);
    assert.ok(res.content.includes("(done)"));
  });

  it("No.8/9/14/15: invalid argument combinations fail before locking", async () => {
    const client = createClient();
    const operations = [{ search: "a", replace: "b" }];
    const invalidOptions = [
      { content: "x", operations }, // No.8
      { content: "", operations }, // No.8 (empty string counts as specified)
      {}, // No.9
      { operations: [] }, // No.9 (empty array counts as unspecified)
      { forceReplaceAll: true }, // No.14
      { forceReplaceAll: true, operations }, // No.15
      { forceReplaceAll: true, content: "x", operations }, // No.15
    ];
    for (const options of invalidOptions) {
      await assert.rejects(() => client.updateBoard(POST_ID, { commitMessage: "x", ...options }));
    }
    assert.equal(mockServer.state.lockCalls, 0);
    assert.equal(mockServer.state.commitCalls, 0);
  });

  it("No.10: forceReplaceAll replaces the whole content", async () => {
    const res = await createClient().updateBoard(POST_ID, {
      commitMessage: "x",
      content: "# Rewritten",
      forceReplaceAll: true,
    });
    assert.equal(res.content, "# Rewritten");
    assert.deepEqual(mockServer.state.lastOperations, [{ search: "", replace: "# Rewritten", type: "replace_all" }]);
  });

  it("No.10: forceReplaceAll with identical content is a no-op", async () => {
    const res = await createClient().updateBoard(POST_ID, {
      commitMessage: "x",
      content: INITIAL,
      forceReplaceAll: true,
    });
    assert.equal(res.changed, false);
    assertReleasedWithoutCommit();
  });

  it("No.11: forceReplaceAll writes to an empty board", async () => {
    mockServer.reset("");
    const res = await createClient().updateBoard(POST_ID, {
      commitMessage: "x",
      content: "# First",
      forceReplaceAll: true,
    });
    assert.equal(res.content, "# First");
  });

  it("No.12: forceReplaceAll with empty content clears the board", async () => {
    const res = await createClient().updateBoard(POST_ID, {
      commitMessage: "Clear",
      content: "",
      forceReplaceAll: true,
    });
    assert.equal(res.changed, true);
    assert.equal(mockServer.state.content, "");
  });

  it("No.13: forceReplaceAll with empty content on an empty board is a no-op", async () => {
    mockServer.reset("");
    const res = await createClient().updateBoard(POST_ID, {
      commitMessage: "x",
      content: "",
      forceReplaceAll: true,
    });
    assert.equal(res.changed, false);
    assertReleasedWithoutCommit();
  });

  it("baseVersion: accepts a match and rejects a stale version", async () => {
    const client = createClient();
    const res = await client.updateBoard(POST_ID, { commitMessage: "ok", content: "# v2", baseVersion: 1 });
    assert.equal(res.version, 2);

    mockServer.state.unlockCalls = 0;
    mockServer.state.commitCalls = 0;
    await assert.rejects(
      () => client.updateBoard(POST_ID, { commitMessage: "stale", content: "# stale", baseVersion: 1 }),
      (err: any) => {
        assert.ok(err instanceof BoardVersionConflictError);
        assert.equal(err.baseVersion, 1);
        assert.equal(err.currentVersion, 2);
        return true;
      }
    );
    assertReleasedWithoutCommit();
    assert.equal(mockServer.state.content, "# v2");
  });

  it("releases the lock when the server rejects the operations", async () => {
    await assert.rejects(() =>
      createClient().updateBoard(POST_ID, {
        commitMessage: "x",
        operations: [{ search: "missing", replace: "x" }],
      })
    );
    assert.equal(mockServer.state.unlockCalls, 1);
    assert.equal(mockServer.state.isLocked, false);
  });

  it("dry run: returns the expected content without persisting", async () => {
    const res = await createClient(true).updateBoard(POST_ID, {
      commitMessage: "dry",
      content: `${INITIAL}\n- Item 2`,
    });
    assert.equal(res.dryRun, true);
    assert.equal(res.changed, true);
    assert.equal(res.version, 2);
    assert.equal(res.content, `${INITIAL}\n- Item 2`);
    assert.equal(mockServer.state.version, 1);
    assert.equal(mockServer.state.isLocked, false);
  });

  it("dry run: the per-call dryRun option also applies to the lock", async () => {
    const res = await createClient(false).updateBoard(POST_ID, {
      commitMessage: "dry",
      content: "# changed",
      dryRun: true,
    });
    assert.equal(res.dryRun, true);
    assert.equal(mockServer.state.isLocked, false);
    assert.equal(mockServer.state.content, INITIAL);
  });

  it("commit: parses dry-run responses", async () => {
    const res = await createClient().commitBoard(POST_ID, {
      baseVersion: 1,
      commitMessage: "dry",
      operations: [{ search: "- Item 1", replace: "- Item 2" }],
      dryRun: true,
    });
    assert.equal(res.dryRun, true);
    assert.equal(res.version, 2);
    assert.equal(res.content, "");
    assert.equal(mockServer.state.version, 1);
  });

  it("updateWithModifier: a returned string is committed as a diff", async () => {
    const res = await createClient().updateBoardWithModifier(POST_ID, "Append", (cur) => `${cur}\n- Item 2`);
    assert.equal(res.changed, true);
    assert.deepEqual(mockServer.state.lastOperations, [{ search: "- Item 1", replace: "- Item 1\n- Item 2" }]);
  });

  it("updateWithModifier: forceReplaceAll uses replace_all for a string", async () => {
    await createClient().updateBoardWithModifier(POST_ID, "Rewrite", () => "# New", { forceReplaceAll: true });
    assert.deepEqual(mockServer.state.lastOperations, [{ search: "", replace: "# New", type: "replace_all" }]);
  });

  it("updateWithModifier: an unchanged string is a no-op", async () => {
    const res = await createClient().updateBoardWithModifier(POST_ID, "x", (cur) => cur);
    assert.equal(res.changed, false);
    assertReleasedWithoutCommit();
  });

  it("updateWithModifier: an empty array is a no-op", async () => {
    const res = await createClient().updateBoardWithModifier(POST_ID, "x", () => []);
    assert.equal(res.changed, false);
    assertReleasedWithoutCommit();
  });

  it("updateWithModifier: an empty string requires forceReplaceAll", async () => {
    await assert.rejects(() => createClient().updateBoardWithModifier(POST_ID, "x", () => ""));
    assertReleasedWithoutCommit();
  });

  it("updateWithModifier: operations cannot be combined with forceReplaceAll", async () => {
    await assert.rejects(() =>
      createClient().updateBoardWithModifier(POST_ID, "x", () => [{ search: "- Item 1", replace: "x" }], {
        forceReplaceAll: true,
      })
    );
    assertReleasedWithoutCommit();
  });
});
