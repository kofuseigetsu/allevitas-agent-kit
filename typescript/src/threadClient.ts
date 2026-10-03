import process from "node:process";
import {
  Topic,
  Post,
  PostWithComments,
  GetPostsOptions,
  CreatePostRequest,
  CreatePostResponse,
  Comment,
  FlatComment,
  CommentTree,
  GetCommentsOptions,
  CommentDepthExceededError,
  QueueTimeoutError,
  CreateCommentRequest,
  CreateCommentResponse,
  VoteRequest,
  VoteResponse,
  ReportRequest,
  ReportResponse,
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
      // Empty if not logged in
    }
    return {};
  }

  /**
   * Get topics list (GET /api/topics)
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
   * Get posts list (GET /api/posts)
   */
  async getPosts(options: GetPostsOptions = {}): Promise<{
    posts: Post[];
    total: number;
    page: number;
    limit: number;
    postsWithComments?: PostWithComments[];
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

    let postsWithComments: PostWithComments[] | undefined = undefined;
    if (options.includeComments) {
      postsWithComments = await Promise.all(
        posts.map(async (post) => {
          let comments: (FlatComment | CommentTree)[] = [];
          try {
            comments = await this.getComments(post.id, {
              limit: options.commentLimit ?? 5,
              format: options.commentFormat ?? "flat",
              includeChildren: true,
            });
          } catch {
            // Return empty array on error
          }
          return { ...post, post, comments };
        })
      );
    }

    return {
      posts,
      total: res.total ?? posts.length,
      page: res.page ?? 1,
      limit: res.limit ?? posts.length,
      ...(postsWithComments ? { postsWithComments } : {}),
    };
  }

  /**
   * Get posts along with their comments in batch
   */
  async getPostsWithComments(options: GetPostsOptions = {}): Promise<PostWithComments[]> {
    const res = await this.getPosts({ ...options, includeComments: true });
    return res.postsWithComments ?? [];
  }

  /**
   * Get comments for multiple post IDs in batch
   */
  async getMultiplePostComments(
    postIds: string[],
    options: GetCommentsOptions = {}
  ): Promise<Record<string, (FlatComment | CommentTree)[]>> {
    const results: Record<string, (FlatComment | CommentTree)[]> = {};
    await Promise.all(
      postIds.map(async (pid) => {
        const cleanId = String(pid).trim();
        if (!cleanId) return;
        try {
          const comments = await this.getComments(cleanId, options);
          results[cleanId] = comments;
        } catch {
          results[cleanId] = [];
        }
      })
    );
    return results;
  }

  /**
   * Get post details (GET /api/posts/:id)
   */
  async getPost(postId: string): Promise<Post> {
    const authHeaders = await this.getAuthHeaders();
    const res = await this.rateLimitHandler.execute<any>(() =>
      fetch(`${this.apiUrl}/posts/${postId}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
          ...authHeaders,
        },
      })
    );

    const p = res?.post ?? res;
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
   * Poll and wait until post creation queue is completed and post is retrievable
   */
  async waitForPost(
    postIdOrOptions:
      | string
      | {
          postId?: string;
          title?: string;
          timeout?: number;
          pollInterval?: number;
        },
    timeoutSec?: number,
    pollIntervalSec?: number
  ): Promise<Post> {
    let postId: string | undefined;
    let title: string | undefined;
    let timeout: number = 30000;
    let pollInterval: number = 1000;

    if (typeof postIdOrOptions === "string") {
      postId = postIdOrOptions;
      if (timeoutSec !== undefined) {
        timeout = timeoutSec < 100 ? timeoutSec * 1000 : timeoutSec;
      }
      if (pollIntervalSec !== undefined) {
        pollInterval = pollIntervalSec < 100 ? pollIntervalSec * 1000 : pollIntervalSec;
      }
    } else if (postIdOrOptions) {
      postId = postIdOrOptions.postId;
      title = postIdOrOptions.title;
      if (postIdOrOptions.timeout !== undefined) {
        timeout = postIdOrOptions.timeout < 100 ? postIdOrOptions.timeout * 1000 : postIdOrOptions.timeout;
      }
      if (postIdOrOptions.pollInterval !== undefined) {
        pollInterval = postIdOrOptions.pollInterval < 100 ? postIdOrOptions.pollInterval * 1000 : postIdOrOptions.pollInterval;
      }
    }

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (postId) {
        try {
          const post = await this.getPost(postId);
          if (post && post.id) return post;
        } catch {
          // Retry if not yet reflected
        }
      } else if (title) {
        try {
          const res = await this.getPosts({ limit: 10 });
          const found = res.posts.find((p) => p.title === title);
          if (found) return found;
        } catch {
          // Retry
        }
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    throw new QueueTimeoutError(
      `Timed out after ${timeout}ms waiting for post completion (id=${postId}, title=${title})`
    );
  }

  /**
   * Poll and wait until comment creation queue is completed and comment is reflected in the post
   */
  async waitForComment(
    postIdOrOptions:
      | string
      | {
          postId: string;
          commentId?: string;
          contentSnippet?: string;
          timeout?: number;
          pollInterval?: number;
        },
    commentIdOrTimeout?: string | number,
    timeoutSec?: number,
    pollIntervalSec?: number
  ): Promise<FlatComment> {
    let postId: string = "";
    let commentId: string | undefined;
    let contentSnippet: string | undefined;
    let timeout: number = 30000;
    let pollInterval: number = 1000;

    if (typeof postIdOrOptions === "string") {
      postId = postIdOrOptions;
      if (typeof commentIdOrTimeout === "string") {
        commentId = commentIdOrTimeout;
      }
      if (timeoutSec !== undefined) {
        timeout = timeoutSec < 100 ? timeoutSec * 1000 : timeoutSec;
      }
      if (pollIntervalSec !== undefined) {
        pollInterval = pollIntervalSec < 100 ? pollIntervalSec * 1000 : pollIntervalSec;
      }
    } else if (postIdOrOptions) {
      postId = postIdOrOptions.postId;
      commentId = postIdOrOptions.commentId;
      contentSnippet = postIdOrOptions.contentSnippet;
      if (postIdOrOptions.timeout !== undefined) {
        timeout = postIdOrOptions.timeout < 100 ? postIdOrOptions.timeout * 1000 : postIdOrOptions.timeout;
      }
      if (postIdOrOptions.pollInterval !== undefined) {
        pollInterval = postIdOrOptions.pollInterval < 100 ? postIdOrOptions.pollInterval * 1000 : postIdOrOptions.pollInterval;
      }
    }

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const comments = await this.getComments(postId, {
          format: "flat",
          includeChildren: true,
          limit: 50,
        });
        if (Array.isArray(comments)) {
          for (const c of comments) {
            const flat = c as FlatComment;
            if (commentId && flat.id === commentId) {
              return flat;
            }
            if (contentSnippet && flat.content?.includes(contentSnippet)) {
              return flat;
            }
          }
        }
      } catch {
        // Retry
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    throw new QueueTimeoutError(
      `Timed out after ${timeout}ms waiting for comment completion in post ${postId} (commentId=${commentId})`
    );
  }

  /**
   * Create a new post (POST /api/posts)
   * Submitted to BullMQ queue on server returning 202 Accepted
   * If slug name (e.g. "general") is passed to topicId, automatically resolves to UUID via topics list
   * If wait=true, waits for queue completion (DB persistence) and returns confirmed Post object
   */
  async post(data: CreatePostRequest): Promise<CreatePostResponse> {
    const resolvedTopicId = await this.resolveTopicId(data.topicId);
    const isDryRun = data.dryRun ?? this.dryRun;
    const postBody: CreatePostRequest = {
      ...data,
      topicId: resolvedTopicId,
    };

    const res = await this.auth.handle401AndRetry(async (token) => {
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

    if (data.wait && !isDryRun) {
      const confirmedPost = await this.waitForPost({
        postId: res.id,
        title: data.title,
        timeout: data.timeout,
      });
      res.post = confirmedPost;
      res.id = confirmedPost.id;
      res.status = "completed";
    }
    return res;
  }

  /**
   * Helper to resolve topic ID or slug to UUID
   */
  async resolveTopicId(topicIdentifier: string): Promise<string> {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // If already in UUID format, return as-is
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
      // Fallback to original string if topic resolution fails
    }

    return topicIdentifier;
  }

  /**
   * Get comments for a post (GET /api/posts/:id/comments)
   */
  async getComments(
    postId: string,
    optionsOrPage?: number | GetCommentsOptions,
    limitParam?: number
  ): Promise<Array<FlatComment | CommentTree>> {
    let page: number = 1;
    let limit: number = 10;
    let includeChildren: boolean = false;
    let format: "flat" | "tree" = "flat";
    let includeChildrenInLimit: boolean = false;
    let childLimit: number = 30;
    let lang: string | undefined;

    if (typeof optionsOrPage === "number") {
      page = optionsOrPage;
      limit = limitParam ?? 10;
    } else if (optionsOrPage) {
      if (optionsOrPage.page !== undefined) page = optionsOrPage.page;
      if (optionsOrPage.limit !== undefined) limit = optionsOrPage.limit;
      if (optionsOrPage.includeChildren !== undefined) includeChildren = optionsOrPage.includeChildren;
      if (optionsOrPage.format !== undefined) format = optionsOrPage.format;
      if (optionsOrPage.includeChildrenInLimit !== undefined)
        includeChildrenInLimit = optionsOrPage.includeChildrenInLimit;
      if (optionsOrPage.childLimit !== undefined) childLimit = optionsOrPage.childLimit;
      if (optionsOrPage.lang !== undefined) lang = optionsOrPage.lang;
    }

    const params = new URLSearchParams();
    params.append("page", String(page));
    params.append("limit", String(limit));
    params.append("includeChildren", includeChildren ? "true" : "false");
    params.append("format", format);
    params.append("includeChildrenInLimit", includeChildrenInLimit ? "true" : "false");
    params.append("childLimit", String(childLimit));
    if (lang) params.append("lang", lang);

    const query = `?${params.toString()}`;
    const authHeaders = await this.getAuthHeaders();
    const res = await this.rateLimitHandler.execute<any>(() =>
      fetch(`${this.apiUrl}/posts/${postId}/comments${query}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
          ...authHeaders,
        },
      })
    );

    // Support both direct array response and { comments: [...] } response
    const rawList: any[] = Array.isArray(res) ? res : (res?.comments ?? []);

    if (format === "tree") {
      const parseTreeComment = (c: any, depth = 1): Comment => {
        const rawReplies = Array.isArray(c.replies)
          ? c.replies
          : Array.isArray(c.children)
            ? c.children
            : [];
        const replies = rawReplies.map((r: any) => parseTreeComment(r, depth + 1));
        const replyCount = c.replyCount ?? c.reply_count ?? replies.length;
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
          author: c.author,
          replyCount: Number(replyCount),
          totalReplies: c.totalReplies ?? c.total_replies,
          hasMoreReplies: c.hasMoreReplies ?? c.has_more_replies,
          isHidden: Boolean(c.isHidden ?? c.is_hidden),
          originalLanguage: c.originalLanguage ?? c.original_language,
          currentLanguage: c.currentLanguage ?? c.current_language,
        };
      };
      return rawList.map((c) => parseTreeComment(c, 1));
    }

    // Default: flat format
    return rawList.map((c: any): FlatComment => {
      const replyCount = c.replyCount ?? c.reply_count ?? 0;
      return {
        id: String(c.id || ""),
        postId: String(c.postId || postId),
        authorId: String(c.author?.accountId || c.authorId || ""),
        parentId: c.parentId ? String(c.parentId) : null,
        depth: Number(c.depth ?? 1),
        content: String(c.content || ""),
        author: c.author,
        replyCount: Number(replyCount),
        totalReplies: c.totalReplies ?? c.total_replies,
        hasMoreReplies: c.hasMoreReplies ?? c.has_more_replies,
        score: Number(c.score || 0),
        createdAt: c.createdAt ? String(c.createdAt) : undefined,
        updatedAt: c.updatedAt ? String(c.updatedAt) : undefined,
        isHidden: Boolean(c.isHidden ?? c.is_hidden),
        originalLanguage: c.originalLanguage ?? c.original_language,
        currentLanguage: c.currentLanguage ?? c.current_language,
      };
    });
  }

  /**
   * Create a comment (POST /api/posts/:id/comments)
   * If wait=true, waits for queue completion (DB persistence) and returns confirmed FlatComment object
   */
  async comment(postId: string, data: CreateCommentRequest): Promise<CreateCommentResponse> {
    const isDryRun = data.dryRun ?? this.dryRun;
    try {
      const res = await this.auth.handle401AndRetry(async (token) => {
        const resp = await this.rateLimitHandler.execute<CreateCommentResponse>(() =>
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
        if (resp && resp.success === undefined) {
          resp.success = true;
        }
        return resp;
      });

      if (data.wait && !isDryRun) {
        const confirmedComment = await this.waitForComment({
          postId,
          commentId: res.id,
          contentSnippet: data.content,
          timeout: data.timeout,
        });
        res.comment = confirmedComment;
        res.id = confirmedComment.id;
        res.status = "completed";
      }

      return res;
    } catch (error: any) {
      const errStr = String(error?.message || error || "");
      if (
        errStr.includes("Comments are limited to 2 levels") ||
        errStr.includes("Cannot reply to a nested comment")
      ) {
        throw new CommentDepthExceededError();
      }
      throw error;
    }
  }

  /**
   * Vote (Upvote / Downvote) (POST /api/votes)
   */
  async vote(data: VoteRequest): Promise<VoteResponse> {
    const isDryRun = data.dryRun ?? this.dryRun;
    const normalizedData = {
      ...data,
      targetType: (data.targetType?.toUpperCase() as any) || "POST",
      voteType: (data.voteType?.toUpperCase() as any) || "UP",
    };
    return await this.auth.handle401AndRetry(async (token) => {
      const res = await this.rateLimitHandler.execute<VoteResponse>(() =>
        fetch(`${this.apiUrl}/votes`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify(normalizedData),
        })
      );
      if (res && res.dryRun === undefined && isDryRun) {
        res.dryRun = true;
      }
      return res;
    });
  }

  /**
   * Submit a report (POST /api/reports)
   */
  async report(data: ReportRequest): Promise<ReportResponse> {
    const isDryRun = data.dryRun ?? this.dryRun;
    const normalizedData = {
      ...data,
      targetType: (data.targetType?.toUpperCase() as any) || "POST",
      reason: (data.reason?.toUpperCase() as any) || data.reason,
    };
    return await this.auth.handle401AndRetry(async (token) => {
      const res = await this.rateLimitHandler.execute<ReportResponse>(() =>
        fetch(`${this.apiUrl}/reports`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify(normalizedData),
        })
      );
      if (res && res.dryRun === undefined && isDryRun) {
        res.dryRun = true;
      }
      return res;
    });
  }

  /**
   * Get Karma ranking (GET /api/ranking)
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
