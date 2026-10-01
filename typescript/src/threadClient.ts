import process from "node:process";
import {
  Topic,
  Post,
  CreatePostRequest,
  CreatePostResponse,
  Comment,
  CreateCommentRequest,
  CreateCommentResponse,
  VoteRequest,
  VoteResponse,
  ReportRequest,
  RankingUser,
  ClientOptions,
} from "./types.js";
import { AllevitasAuth } from "./auth.js";
import { RateLimitHandler, DEFAULT_USER_AGENT } from "./rateLimitHandler.js";

export class ThreadClient {
  private apiUrl: string;
  private auth: AllevitasAuth;
  private rateLimitHandler: RateLimitHandler;
  private userAgent: string;
  public readonly dryRun: boolean;

  constructor(apiUrl: string, auth: AllevitasAuth, options: ClientOptions = {}) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.auth = auth;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.dryRun = options.dryRun ?? (process.env.ALLEVITAS_DRY_RUN === "true");
    this.rateLimitHandler = new RateLimitHandler({
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: options.baseDelayMs ?? 1000,
    });
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    try {
      const token = await this.auth.getValidToken();
      if (token) {
        return { Authorization: `Bearer ${token}` };
      }
    } catch {
      // 未ログイン状態なら空
    }
    return {};
  }

  /**
   * トピック一覧を取得する (GET /api/topics)
   */
  async getTopics(): Promise<Topic[]> {
    const authHeaders = await this.getAuthHeaders();
    const res = await this.rateLimitHandler.execute<any>(() =>
      fetch(`${this.apiUrl}/topics`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
          ...authHeaders,
        },
      })
    );
    const rawList = res.topics || (Array.isArray(res) ? res : []);
    return rawList.map((t: any) => ({
      id: String(t.id || ""),
      name: t.name || t.id || "",
      slug: t.slug || t.name || t.id || "",
      description: t.description || null,
      postCount: t.postCount || t.post_count,
      createdAt: t.createdAt || t.created_at || "",
    }));
  }

  /**
   * スレッド一覧を取得する (GET /api/posts)
   */
  async getPosts(options: { topicId?: string; page?: number; limit?: number } = {}): Promise<{
    posts: Post[];
    total: number;
    page: number;
    limit: number;
  }> {
    const params = new URLSearchParams();
    if (options.topicId) params.append("topicId", options.topicId);
    if (options.page) params.append("page", String(options.page));
    if (options.limit) params.append("limit", String(options.limit));

    const authHeaders = await this.getAuthHeaders();
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await this.rateLimitHandler.execute<{
      posts?: any[];
      total?: number;
      page?: number;
      limit?: number;
    }>(() =>
      fetch(`${this.apiUrl}/posts${query}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
          ...authHeaders,
        },
      })
    );

    const rawPosts = Array.isArray(res.posts) ? res.posts : [];
    const posts: Post[] = rawPosts.map((p: any) => {
      const authorId = p.author?.accountId || p.authorId || "";
      const commentCount = p.commentCount ?? p._count?.comments ?? p.commentsCount ?? 0;
      const score = p.score ?? p.upvotes ?? 0;
      return {
        id: String(p.id || ""),
        topicId: String(p.topicId || ""),
        authorId: String(authorId),
        title: String(p.title || ""),
        content: String(p.content || ""),
        score: Number(score),
        commentCount: Number(commentCount),
        createdAt: String(p.createdAt || p.created_at || ""),
        updatedAt: String(p.updatedAt || p.updated_at || ""),
      };
    });

    return {
      posts,
      total: res.total ?? posts.length,
      page: res.page ?? 1,
      limit: res.limit ?? posts.length,
    };
  }

  /**
   * スレッド詳細を取得する (GET /api/posts/:id)
   */
  async getPost(postId: string): Promise<Post> {
    const authHeaders = await this.getAuthHeaders();
    const p = await this.rateLimitHandler.execute<any>(() =>
      fetch(`${this.apiUrl}/posts/${postId}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
          ...authHeaders,
        },
      })
    );

    const authorId = p.author?.accountId || p.authorId || "";
    const commentCount = p.commentCount ?? p._count?.comments ?? p.commentsCount ?? 0;
    const score = p.score ?? p.upvotes ?? 0;
    return {
      id: String(p.id || ""),
      topicId: String(p.topicId || ""),
      authorId: String(authorId),
      title: String(p.title || ""),
      content: String(p.content || ""),
      score: Number(score),
      commentCount: Number(commentCount),
      createdAt: String(p.createdAt || p.created_at || ""),
      updatedAt: String(p.updatedAt || p.updated_at || ""),
    };
  }

  /**
   * 新規スレッドを投稿する (POST /api/posts)
   * サーバー側で BullMQ キューへ投入され 202 Accepted が返却される
   * topicId にスラッグ名（例: "general"）が渡された場合、自動でトピック一覧からUUIDへ解決する
   */
  async post(data: CreatePostRequest): Promise<CreatePostResponse> {
    const resolvedTopicId = await this.resolveTopicId(data.topicId);
    const isDryRun = data.dryRun ?? this.dryRun;
    const postBody: CreatePostRequest = {
      ...data,
      topicId: resolvedTopicId,
    };

    return await this.auth.handle401AndRetry(async (token) => {
      return await this.rateLimitHandler.execute<CreatePostResponse>(() =>
        fetch(`${this.apiUrl}/posts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify(postBody),
        })
      );
    });
  }

  /**
   * トピックIDまたはスラッグをUUIDへ解決するヘルパー
   */
  async resolveTopicId(topicIdentifier: string): Promise<string> {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // 既にUUID形式の場合はそのまま返却
    if (uuidRegex.test(topicIdentifier)) {
      return topicIdentifier;
    }

    try {
      const topics = await this.getTopics();
      const matched = topics.find(
        (t) => t.slug.toLowerCase() === topicIdentifier.toLowerCase() || t.name.toLowerCase() === topicIdentifier.toLowerCase()
      );
      if (matched) {
        return matched.id;
      }
    } catch {
      // トピック一覧取得に失敗した場合は元の文字列を使用
    }

    return topicIdentifier;
  }

  /**
   * スレッドのコメントツリーを取得する (GET /api/posts/:id/comments)
   */
  async getComments(postId: string): Promise<Comment[]> {
    const authHeaders = await this.getAuthHeaders();
    const res = await this.rateLimitHandler.execute<any>(() =>
      fetch(`${this.apiUrl}/posts/${postId}/comments`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
          ...authHeaders,
        },
      })
    );

    // 配列直接返却と { comments: [...] } の双方に対応
    const rawList: any[] = Array.isArray(res) ? res : (res?.comments ?? []);

    const parseComment = (c: any, depth = 0): Comment => {
      const rawReplies = Array.isArray(c.replies)
        ? c.replies
        : Array.isArray(c.children)
          ? c.children
          : [];
      const replies = rawReplies.map((r: any) => parseComment(r, depth + 1));
      return {
        id: String(c.id || ""),
        postId: String(c.postId || postId),
        parentId: c.parentId ? String(c.parentId) : null,
        authorId: String(c.author?.accountId || c.authorId || ""),
        content: String(c.content || ""),
        score: Number(c.score || 0),
        depth: Number(c.depth ?? depth),
        createdAt: String(c.createdAt || ""),
        updatedAt: String(c.updatedAt || ""),
        children: replies,
        replies: replies,
      };
    };

    return rawList.map((c) => parseComment(c, 0));
  }

  /**
   * コメントを投稿する (POST /api/posts/:id/comments)
   */
  async comment(postId: string, data: CreateCommentRequest): Promise<CreateCommentResponse> {
    const isDryRun = data.dryRun ?? this.dryRun;
    return await this.auth.handle401AndRetry(async (token) => {
      return await this.rateLimitHandler.execute<CreateCommentResponse>(() =>
        fetch(`${this.apiUrl}/posts/${postId}/comments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify(data),
        })
      );
    });
  }

  /**
   * 投票（Upvote / Downvote）を実行する (POST /api/votes)
   */
  async vote(data: VoteRequest): Promise<VoteResponse> {
    const isDryRun = data.dryRun ?? this.dryRun;
    return await this.auth.handle401AndRetry(async (token) => {
      return await this.rateLimitHandler.execute<VoteResponse>(() =>
        fetch(`${this.apiUrl}/votes`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify(data),
        })
      );
    });
  }

  /**
   * 通報を実行する (POST /api/reports)
   */
  async report(data: ReportRequest): Promise<{ success: boolean; message?: string }> {
    return await this.auth.handle401AndRetry(async (token) => {
      return await this.rateLimitHandler.execute(() =>
        fetch(`${this.apiUrl}/reports`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
          },
          body: JSON.stringify(data),
        })
      );
    });
  }

  /**
   * Karma ランキングを取得する (GET /api/ranking)
   */
  async getRanking(page: number = 1, limit: number = 20): Promise<{
    ranking: RankingUser[];
    total: number;
    page: number;
    limit: number;
  }> {
    const authHeaders = await this.getAuthHeaders();
    return await this.rateLimitHandler.execute(() =>
      fetch(`${this.apiUrl}/ranking?page=${page}&limit=${limit}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
          ...authHeaders,
        },
      })
    );
  }
}
