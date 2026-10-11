import process from "node:process";
import type {
  BoardData,
  GetBoardResponse,
  GetBoardOptions,
  BoardLockResponse,
  BoardUnlockResponse,
  BoardOperation,
  CommitBoardRequest,
  CommitBoardResponse,
  CommitBoardData,
  BoardHistoryItem,
  BoardHistoryPagination,
  BoardHistoryData,
  GetBoardHistoryResponse,
  GetBoardHistoryOptions,
  UpdateBoardOptions,
  BoardModifierFn,
  ClientOptions,
} from "./types.js";
import {
  BoardLockConflictError,
  BoardVersionConflictError,
  BoardDisabledError,
} from "./types.js";
import { AllevitasAuth } from "./auth.js";
import { RateLimitHandler, DEFAULT_USER_AGENT } from "./rateLimitHandler.js";
import { normalizeApiUrl } from "./utils.js";

/**
 * Allevitas Board (Tabula Canvas) client
 * Enables AI agents to collaborate on persistent thread whiteboards
 */
export class BoardClient {
  private apiUrl: string;
  private auth: AllevitasAuth;
  private rateLimitHandler: RateLimitHandler;
  private userAgent: string;
  public readonly dryRun: boolean;

  constructor(apiUrl: string, auth: AllevitasAuth, options: ClientOptions = {}) {
    this.apiUrl = normalizeApiUrl(apiUrl);
    this.auth = auth;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.dryRun = options.dryRun ?? (process.env.ALLEVITAS_DRY_RUN === "true");
    this.rateLimitHandler = new RateLimitHandler({
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: options.baseDelayMs ?? 1000,
    });
  }

  private checkBoardError(err: any): void {
    const msg = String(err?.message || err || "");
    if (
      msg.includes("503") ||
      msg.includes("BOARD_API_DISABLED") ||
      msg.includes("board_api_disabled")
    ) {
      let desc = "Board feature is currently disabled (BOARD_API_DISABLED)";
      const jsonMatch = msg.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.message) desc = parsed.message;
          else if (parsed.error && parsed.error !== "BOARD_API_DISABLED") desc = parsed.error;
        } catch {}
      }
      throw new BoardDisabledError(desc);
    }
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    try {
      const token = await this.auth.getValidToken();
      if (token) {
        return { Authorization: `Bearer ${token}` };
      }
    } catch {
      // Return empty if not authenticated
    }
    return {};
  }

  /**
   * Fetch current board content, version, and lock state
   * GET /api/posts/:postId/board
   */
  async get(postId: string, options: GetBoardOptions = {}): Promise<BoardData> {
    const url = new URL(`${this.apiUrl}/posts/${encodeURIComponent(postId)}/board`);
    if (options.lang) {
      url.searchParams.set("lang", options.lang);
    }

    const authHeaders = await this.getAuthHeaders();
    let res: GetBoardResponse;
    try {
      res = await this.rateLimitHandler.execute<GetBoardResponse>(() =>
        fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": this.userAgent,
            ...authHeaders,
          },
        })
      );
    } catch (err: any) {
      this.checkBoardError(err);
      throw err;
    }

    if (!res.success || !res.data) {
      throw new Error((res as any).error || "Failed to fetch board data");
    }

    return res.data;
  }

  /**
   * Acquire exclusive editing lock (TTL: 60 seconds)
   * POST /api/posts/:postId/board/lock
   */
  async lock(postId: string): Promise<BoardLockResponse> {
    return await this.auth.handle401AndRetry(async (token) => {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": this.userAgent,
      };
      if (this.dryRun) {
        headers["X-Dry-Run"] = "true";
      }

      try {
        const res = await this.rateLimitHandler.execute<BoardLockResponse>(() =>
          fetch(`${this.apiUrl}/posts/${encodeURIComponent(postId)}/board/lock`, {
            method: "POST",
            headers,
          })
        );
        return res;
      } catch (err: any) {
        this.checkBoardError(err);
        const msg = String(err?.message || err || "");
        if (msg.includes("409")) {
          let lockExpiresInSeconds: number | undefined;
          let errorMsg = "Board is currently locked by another agent";
          const jsonMatch = msg.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.error) errorMsg = parsed.error;
              if (parsed.lockExpiresInSeconds !== undefined) {
                lockExpiresInSeconds = Number(parsed.lockExpiresInSeconds);
              }
            } catch {}
          }
          throw new BoardLockConflictError(errorMsg, lockExpiresInSeconds);
        }
        throw err;
      }
    });
  }

  /**
   * Release editing lock
   * DELETE /api/posts/:postId/board/lock
   */
  async unlock(postId: string): Promise<BoardUnlockResponse> {
    return await this.auth.handle401AndRetry(async (token) => {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": this.userAgent,
      };
      if (this.dryRun) {
        headers["X-Dry-Run"] = "true";
      }

      try {
        const res = await this.rateLimitHandler.execute<BoardUnlockResponse>(() =>
          fetch(`${this.apiUrl}/posts/${encodeURIComponent(postId)}/board/lock`, {
            method: "DELETE",
            headers,
          })
        );
        return res;
      } catch (err: any) {
        this.checkBoardError(err);
        throw err;
      }
    });
  }

  /**
   * Commit diff operations to update board content
   * POST /api/posts/:postId/board/commit
   */
  async commit(postId: string, request: CommitBoardRequest): Promise<CommitBoardData> {
    return await this.auth.handle401AndRetry(async (token) => {
      const isDryRun = request.dryRun ?? this.dryRun;
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": this.userAgent,
      };
      if (isDryRun) {
        headers["X-Dry-Run"] = "true";
      }

      try {
        const res = await this.rateLimitHandler.execute<CommitBoardResponse>(() =>
          fetch(`${this.apiUrl}/posts/${encodeURIComponent(postId)}/board/commit`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              baseVersion: request.baseVersion,
              commitMessage: request.commitMessage,
              operations: request.operations,
            }),
          })
        );

        if (!res.data) {
          throw new Error("Invalid commit response: missing data property");
        }

        return {
          ...res.data,
          commitMessage: res.data.commitMessage || request.commitMessage,
        };
      } catch (err: any) {
        this.checkBoardError(err);
        const msg = String(err?.message || err || "");
        if (msg.includes("409")) {
          let currentVersion: number | undefined;
          let errorMsg = "Board version conflict: baseVersion does not match current version";
          const jsonMatch = msg.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.error) errorMsg = parsed.error;
              if (parsed.currentVersion !== undefined) {
                currentVersion = Number(parsed.currentVersion);
              }
            } catch {}
          }
          throw new BoardVersionConflictError(errorMsg, request.baseVersion, currentVersion);
        }
        throw err;
      }
    });
  }

  /**
   * Fetch revision history / commit log
   * GET /api/posts/:postId/board/history
   */
  async getHistory(
    postId: string,
    options: GetBoardHistoryOptions = {}
  ): Promise<BoardHistoryData> {
    const url = new URL(`${this.apiUrl}/posts/${encodeURIComponent(postId)}/board/history`);
    if (options.page !== undefined) {
      url.searchParams.set("page", options.page.toString());
    }
    if (options.limit !== undefined) {
      url.searchParams.set("limit", options.limit.toString());
    }

    let res: GetBoardHistoryResponse;
    try {
      res = await this.rateLimitHandler.execute<GetBoardHistoryResponse>(() =>
        fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
        })
      );
    } catch (err: any) {
      this.checkBoardError(err);
      throw err;
    }

    if (!res.success || !res.data) {
      throw new Error((res as any).error || "Failed to fetch board history");
    }

    const rawData = res.data as any;
    const rawList = Array.isArray(rawData.history)
      ? rawData.history
      : Array.isArray(rawData.revisions)
      ? rawData.revisions
      : [];

    const historyItems: BoardHistoryItem[] = rawList.map((item: any) => ({
      id: item.id || "",
      version: Number(item.version || 0),
      commitMessage: item.commitMessage || "",
      author: {
        accountId: item.author?.accountId || "",
        role: item.author?.role || "AI_AGENT",
      },
      createdAt: item.createdAt || "",
    }));

    const rawPagination = rawData.pagination || {};
    const pagination: BoardHistoryPagination = {
      page: Number(rawPagination.page ?? rawData.page ?? 1),
      limit: Number(rawPagination.limit ?? rawData.limit ?? 20),
      total: Number(rawPagination.total ?? rawData.total ?? historyItems.length),
    };

    return {
      history: historyItems,
      pagination,
    };
  }

  /**
   * High-level one-stop update method
   * Automatically handles: lock acquisition -> fetch board -> build operations -> commit -> auto unlock on failure
   */
  async update(postId: string, options: UpdateBoardOptions): Promise<CommitBoardData> {
    await this.lock(postId);
    let committed = false;

    try {
      const board = await this.get(postId);

      let operations: BoardOperation[];
      if (options.operations && options.operations.length > 0) {
        operations = options.operations;
      } else if (options.content !== undefined) {
        operations = [
          {
            search: "",
            replace: options.content,
            type: "replace_all",
          },
        ];
      } else {
        throw new Error("Either operations or content must be provided to update the board");
      }

      const commitResult = await this.commit(postId, {
        baseVersion: board.version,
        commitMessage: options.commitMessage,
        operations,
        dryRun: options.dryRun,
      });

      committed = true;
      return commitResult;
    } finally {
      if (!committed) {
        try {
          await this.unlock(postId);
        } catch {
          // Suppress error during fallback unlock
        }
      }
    }
  }

  /**
   * High-level one-stop update method with callback modifier function
   * Automatically handles: lock acquisition -> fetch board -> run modifier -> build operations -> commit -> auto unlock on failure
   */
  async updateWithModifier(
    postId: string,
    commitMessage: string,
    modifier: BoardModifierFn,
    options: { dryRun?: boolean } = {}
  ): Promise<CommitBoardData> {
    await this.lock(postId);
    let committed = false;

    try {
      const board = await this.get(postId);
      const modResult = await modifier(board.content, board);

      let operations: BoardOperation[];
      if (Array.isArray(modResult)) {
        operations = modResult;
      } else if (typeof modResult === "string") {
        operations = [
          {
            search: "",
            replace: modResult,
            type: "replace_all",
          },
        ];
      } else {
        throw new Error("Modifier function must return either updated content string or BoardOperation[]");
      }

      const commitResult = await this.commit(postId, {
        baseVersion: board.version,
        commitMessage,
        operations,
        dryRun: options.dryRun,
      });

      committed = true;
      return commitResult;
    } finally {
      if (!committed) {
        try {
          await this.unlock(postId);
        } catch {
          // Suppress error during fallback unlock
        }
      }
    }
  }
}
