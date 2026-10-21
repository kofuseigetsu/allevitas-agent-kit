/**
 * Shared mock board server for Tabula Canvas tests
 */

import http from "node:http";

/**
 * Mirror of the server diff engine (non-overlapping count, literal replace).
 * Throws an Error whose message is the server error code.
 */
export function serverApplyOperations(
  content: string,
  operations: Array<{ search?: string; replace?: string; type?: string }>
): string {
  let current = content.replace(/\r\n/g, "\n");
  for (const op of operations) {
    const search = (op.search ?? "").replace(/\r\n/g, "\n");
    const replace = (op.replace ?? "").replace(/\r\n/g, "\n");
    if (op.type === "replace_all" || (!search && current === "")) {
      current = replace;
      continue;
    }
    if (!search) throw new Error("INVALID_OPERATION");
    const count = current.split(search).length - 1;
    if (count === 0) throw new Error("TARGET_NOT_FOUND");
    if (count > 1) throw new Error("AMBIGUOUS_SEARCH_TARGET");
    const idx = current.indexOf(search);
    current = current.slice(0, idx) + replace + current.slice(idx + search.length);
  }
  return current;
}

export interface MockBoardState {
  postId: string;
  version: number;
  content: string;
  isLocked: boolean;
  lockCalls: number;
  unlockCalls: number;
  commitCalls: number;
  lastOperations: any[] | null;
  /** When set, the next commit is rejected with this 422 error code */
  rejectNextCommit: string | null;
}

export interface MockBoardServer {
  url: string;
  state: MockBoardState;
  reset(content: string, version?: number): void;
  close(): Promise<void>;
}

/**
 * Start a mock board server for `postId` that behaves like the real API,
 * including dry-run responses (`validatedData`) and 422 diff errors.
 */
export async function startMockBoardServer(postId: string): Promise<MockBoardServer> {
  const state: MockBoardState = {
    postId,
    version: 1,
    content: "",
    isLocked: false,
    lockCalls: 0,
    unlockCalls: 0,
    commitCalls: 0,
    lastOperations: null,
    rejectNextCommit: null,
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    let bodyText = "";
    for await (const chunk of req) {
      bodyText += chunk;
    }
    const body = bodyText ? JSON.parse(bodyText) : {};
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const isDryRun = req.headers["x-dry-run"] === "true";
    const base = `/posts/${postId}/board`;

    if (req.method === "GET" && url.pathname === base) {
      send(res, 200, {
        success: true,
        data: {
          postId: state.postId,
          version: state.version,
          content: state.content,
          isLocked: state.isLocked,
          lockExpiresInSeconds: state.isLocked ? 45 : 0,
          isLockedByMe: state.isLocked,
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === `${base}/lock`) {
      state.lockCalls++;
      if (!isDryRun) state.isLocked = true;
      send(res, 200, { success: true, message: "Lock acquired", expiresInSeconds: 60 });
      return;
    }

    if (req.method === "DELETE" && url.pathname === `${base}/lock`) {
      state.unlockCalls++;
      if (!isDryRun) state.isLocked = false;
      send(res, 200, { success: true, message: "Lock released" });
      return;
    }

    if (req.method === "POST" && url.pathname === `${base}/commit`) {
      state.commitCalls++;
      state.lastOperations = body.operations ?? null;
      if (body.baseVersion !== state.version) {
        send(res, 409, { success: false, error: "Version mismatch", currentVersion: state.version });
        return;
      }
      if (state.rejectNextCommit) {
        const code = state.rejectNextCommit;
        state.rejectNextCommit = null;
        send(res, 422, { error: code, message: code });
        return;
      }
      let newContent: string;
      try {
        newContent = serverApplyOperations(state.content, body.operations || []);
      } catch (err: any) {
        send(res, 422, { error: err.message, message: err.message });
        return;
      }
      if (isDryRun) {
        send(res, 200, {
          message: "[Dry Run] Validation successful. Diff applied and validated.",
          status: "dry_run",
          dryRun: true,
          validatedData: { postId: state.postId, newVersion: state.version + 1, contentLength: newContent.length },
        });
        return;
      }
      state.version += 1;
      state.content = newContent;
      state.isLocked = false;
      send(res, 200, {
        success: true,
        data: { postId: state.postId, version: state.version, content: state.content },
      });
      return;
    }

    send(res, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as any;

  return {
    url: `http://127.0.0.1:${addr.port}`,
    state,
    reset(content: string, version = 1) {
      state.version = version;
      state.content = content;
      state.isLocked = false;
      state.lockCalls = 0;
      state.unlockCalls = 0;
      state.commitCalls = 0;
      state.lastOperations = null;
      state.rejectNextCommit = null;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
