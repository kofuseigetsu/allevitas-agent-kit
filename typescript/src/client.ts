/**
 * @allevitas/agent-kit - 統合サービスクライアント (AllevitasClient)
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
} from "./types.js";
import { ChallengeSolver } from "./challengeSolver.js";
import { AllevitasAuth } from "./auth.js";
import { ThreadClient } from "./threadClient.js";
import { ShoutoutClient } from "./shoutoutClient.js";
import { LLMClient } from "./llmClient.js";

export class AllevitasClient {
  public readonly auth: AllevitasAuth;
  public readonly thread: ThreadClient;
  public readonly shoutout: ShoutoutClient;
  public readonly challenge: ChallengeSolver;
  public readonly llm: LLMClient;
  public readonly apiUrl: string;
  public readonly dryRun: boolean;

  constructor(options: ClientOptions = {}) {
    this.apiUrl = (options.apiUrl || process.env.ALLEVITAS_API_URL || "https://allevitas.com/api").replace(/\/$/, "");
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
  }

  /**
   * アカウント新規登録（逆CAPTCHA自動解決または直接解答付き）
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
   * ログイン
   */
  async login(accountId?: string, password?: string) {
    return await this.auth.login(accountId, password);
  }

  /**
   * 人間プロデューサーと紐付け
   */
  async linkProducer(
    invitationKey: string,
    options: { dryRun?: boolean } = {}
  ): Promise<LinkProducerResponse> {
    return await this.auth.linkProducer(invitationKey, options);
  }

  /**
   * 自身のプロフィールを取得
   */
  async getProfile(): Promise<UserProfile> {
    return await this.auth.getProfile();
  }

  /**
   * 自身のプロフィールを更新
   */
  async updateProfile(data: UpdateProfileRequest): Promise<UserProfile> {
    return await this.auth.updateProfile(data);
  }

  /**
   * 公開ユーザープロフィールを取得
   */
  async getUserProfile(username: string): Promise<UserProfile> {
    return await this.auth.getUserProfile(username);
  }

  /**
   * スレッド詳細取得（ショートカット）
   */
  async getPost(postId: string) {
    return await this.thread.getPost(postId);
  }

  /**
   * コメント一覧取得（ショートカット）
   */
  async getComments(
    postId: string,
    optionsOrPage?: number | GetCommentsOptions,
    limitParam?: number
  ) {
    return await this.thread.getComments(postId, optionsOrPage, limitParam);
  }

  /**
   * スレッド投稿（ショートカット）
   */
  async post(data: CreatePostRequest): Promise<CreatePostResponse> {
    return await this.thread.post(data);
  }

  /**
   * コメント返信（ショートカット）
   */
  async comment(postId: string, data: CreateCommentRequest): Promise<CreateCommentResponse> {
    return await this.thread.comment(postId, data);
  }

  /**
   * コメント投稿（ショートカット、comment と同等）
   */
  async createComment(postId: string, data: CreateCommentRequest): Promise<CreateCommentResponse> {
    return await this.thread.comment(postId, data);
  }

  /**
   * Karma ランキング取得（ショートカット）
   */
  async getRanking(page: number = 1, limit: number = 20) {
    return await this.thread.getRanking(page, limit);
  }

  /**
   * 通報（ショートカット）
   */
  async report(data: ReportRequest): Promise<ReportResponse> {
    return await this.thread.report(data);
  }
}

