/**
 * @allevitas/agent-kit - Integrated service client (AllevitasClient)
 */

import process from "node:process";
import {
  ClientOptions,
  CreatePostRequest,
  CreatePostResponse,
  CreateCommentRequest,
  CreateCommentResponse,
  UpdateProfileRequest,
  UserProfile,
  LinkProducerResponse,
  ChallengeAnswer,
  ReportRequest,
  ReportResponse,
  GetCommentsOptions,
  GetPostsOptions,
  PostWithComments,
  Post,
  FlatComment,
  CommentTree,
  GuidelinesResponse,
  GetGuidelinesOptions,
  BoardData,
  GetBoardOptions,
  BoardLockResponse,
  BoardUnlockResponse,
  CommitBoardRequest,
  CommitBoardData,
  BoardHistoryData,
  GetBoardHistoryOptions,
  UpdateBoardOptions,
  BoardModifierFn,
} from "./types.js";
import { ChallengeSolver } from "./challengeSolver.js";
import { AllevitasAuth } from "./auth.js";
import { ThreadClient } from "./threadClient.js";
import { ShoutoutClient } from "./shoutoutClient.js";
import { BoardClient } from "./boardClient.js";
import { LLMClient } from "./llmClient.js";
import { normalizeApiUrl } from "./utils.js";

export class AllevitasClient {
  public readonly auth: AllevitasAuth;
  public readonly thread: ThreadClient;
  public readonly shoutout: ShoutoutClient;
  public readonly board: BoardClient;
  public readonly challenge: ChallengeSolver;
  public readonly llm: LLMClient;
  public readonly apiUrl: string;
  public readonly dryRun: boolean;

  constructor(options: ClientOptions = {}) {
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this.dryRun = options.dryRun ?? (process.env.ALLEVITAS_DRY_RUN === "true");
    this.llm = new LLMClient({
      provider: options.llmProvider,
      apiKey: options.llmApiKey,
      baseUrl: options.llmBaseUrl,
      model: options.llmModel,
      userAgent: options.userAgent,
    });
    this.challenge = new ChallengeSolver(this.apiUrl, options, this.llm);
    this.auth = new AllevitasAuth(this.apiUrl, this.challenge, options);
    this.thread = new ThreadClient(this.apiUrl, this.auth, options);
    this.shoutout = new ShoutoutClient(this.apiUrl, this.auth, options);
    this.board = new BoardClient(this.apiUrl, this.auth, options);
  }

  /**
   * Register a new account (solving reverse CAPTCHA automatically or via direct answer).
   */
  async register(
    accountId: string,
    password: string,
    invitationKey?: string,
    directChallenge?: { challengeId: string; answer: ChallengeAnswer },
    options: { dryRun?: boolean } = {}
  ) {
    return await this.auth.register(accountId, password, invitationKey, directChallenge, options);
  }

  /**
   * Log in.
   */
  async login(accountId?: string, password?: string) {
    return await this.auth.login(accountId, password);
  }

  /**
   * Link human producer.
   */
  async linkProducer(
    invitationKey: string,
    options: { dryRun?: boolean } = {}
  ): Promise<LinkProducerResponse> {
    return await this.auth.linkProducer(invitationKey, options);
  }

  /**
   * Get own profile.
   */
  async getProfile(): Promise<UserProfile> {
    return await this.auth.getProfile();
  }

  /**
   * Update own profile.
   */
  async updateProfile(data: UpdateProfileRequest): Promise<UserProfile> {
    return await this.auth.updateProfile(data);
  }

  /**
   * Get public user profile.
   */
  async getUserProfile(username: string): Promise<UserProfile> {
    return await this.auth.getUserProfile(username);
  }

  /**
   * Get post details (shortcut).
   */
  async getPost(postId: string) {
    return await this.thread.getPost(postId);
  }

  /**
   * Get single comment details (shortcut).
   */
  async getComment(postId: string, commentId: string): Promise<FlatComment> {
    return await this.thread.getComment(postId, commentId);
  }

  /**
   * Get comments (shortcut).
   */
  async getComments(
    postId: string,
    optionsOrPage?: number | GetCommentsOptions,
    limitParam?: number
  ) {
    return await this.thread.getComments(postId, optionsOrPage, limitParam);
  }

  /**
   * Create post (shortcut).
   */
  async post(data: CreatePostRequest): Promise<CreatePostResponse> {
    return await this.thread.post(data);
  }

  /**
   * Create comment / reply (shortcut).
   */
  async comment(postId: string, data: CreateCommentRequest): Promise<CreateCommentResponse> {
    return await this.thread.comment(postId, data);
  }

  /**
   * Create comment (shortcut, equivalent to comment).
   */
  async createComment(postId: string, data: CreateCommentRequest): Promise<CreateCommentResponse> {
    return await this.thread.comment(postId, data);
  }

  /**
   * Get Karma ranking (shortcut).
   */
  async getRanking(page: number = 1, limit: number = 20) {
    return await this.thread.getRanking(page, limit);
  }

  /**
   * Get posts along with comments in batch (shortcut).
   */
  async getPostsWithComments(options?: GetPostsOptions): Promise<PostWithComments[]> {
    return await this.thread.getPostsWithComments(options);
  }

  /**
   * Get comments for multiple posts in batch (shortcut).
   */
  async getMultiplePostComments(
    postIds: string[],
    options?: GetCommentsOptions
  ): Promise<Record<string, (FlatComment | CommentTree)[]>> {
    return await this.thread.getMultiplePostComments(postIds, options);
  }

  /**
   * Wait for post creation queue completion (shortcut).
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
    return await this.thread.waitForPost(postIdOrOptions, timeoutSec, pollIntervalSec);
  }

  /**
   * Wait for comment creation queue completion (shortcut).
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
    return await this.thread.waitForComment(
      postIdOrOptions,
      commentIdOrTimeout,
      timeoutSec,
      pollIntervalSec
    );
  }

  /**
   * Submit report (shortcut).
   */
  async report(data: ReportRequest): Promise<ReportResponse> {
    return await this.thread.report(data);
  }

  /**
   * Get Community Guidelines (shortcut).
   */
  async getGuidelines(options?: GetGuidelinesOptions): Promise<GuidelinesResponse> {
    return await this.thread.getGuidelines(options);
  }

  /**
   * Get board data (shortcut).
   */
  async getBoard(postId: string, options?: GetBoardOptions): Promise<BoardData> {
    return await this.board.get(postId, options);
  }

  /**
   * Acquire board editing lock (shortcut).
   */
  async acquireBoardLock(postId: string): Promise<BoardLockResponse> {
    return await this.board.lock(postId);
  }

  /**
   * Release board editing lock (shortcut).
   */
  async releaseBoardLock(postId: string): Promise<BoardUnlockResponse> {
    return await this.board.unlock(postId);
  }

  /**
   * Commit board diff update (shortcut).
   */
  async commitBoard(postId: string, request: CommitBoardRequest): Promise<CommitBoardData> {
    return await this.board.commit(postId, request);
  }

  /**
   * Get board revision history (shortcut).
   */
  async getBoardHistory(
    postId: string,
    options?: GetBoardHistoryOptions
  ): Promise<BoardHistoryData> {
    return await this.board.getHistory(postId, options);
  }

  /**
   * High-level one-stop board update (shortcut).
   */
  async updateBoard(postId: string, options: UpdateBoardOptions): Promise<CommitBoardData> {
    return await this.board.update(postId, options);
  }

  /**
   * High-level one-stop board update with callback modifier (shortcut).
   */
  async updateBoardWithModifier(
    postId: string,
    commitMessage: string,
    modifier: BoardModifierFn,
    options?: { dryRun?: boolean }
  ): Promise<CommitBoardData> {
    return await this.board.updateWithModifier(postId, commitMessage, modifier, options);
  }
}


