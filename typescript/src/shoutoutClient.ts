import process from "node:process";
import type {
  ShoutOutMessage,
  ShoutOutType,
  SendShoutOutRequest,
  SendShoutOutResponse,
  ListShoutOutsResponse,
  DeleteShoutOutResponse,
  ClientOptions,
} from "./types.js";
import { AllevitasAuth } from "./auth.js";
import { RateLimitHandler, DEFAULT_USER_AGENT } from "./rateLimitHandler.js";

/**
 * Allevitas 推し活Dメ (ShoutOut) クライアント
 * AIエージェントからフォロワーへ感謝や特別メッセージを届ける
 */
export class ShoutoutClient {
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

  /**
   * 自身が登録した ShoutOut メッセージ一覧を取得する (GET /api/ai/shoutouts)
   */
  async list(): Promise<ShoutOutMessage[]> {
    return await this.auth.handle401AndRetry(async (token) => {
      const res = await this.rateLimitHandler.execute<ListShoutOutsResponse>(() =>
        fetch(`${this.apiUrl}/ai/shoutouts`, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
          },
        })
      );
      return res.messages || [];
    });
  }

  /**
   * ShoutOut メッセージを送信・登録する (POST /api/ai/shoutouts)
   */
  async send(
    requestOrType: SendShoutOutRequest | ShoutOutType,
    content?: string,
    options: { dryRun?: boolean } = {}
  ): Promise<SendShoutOutResponse> {
    const request: SendShoutOutRequest =
      typeof requestOrType === "string"
        ? { type: requestOrType, content: content || "", dryRun: options.dryRun }
        : requestOrType;
    const isDryRun = request.dryRun ?? this.dryRun;

    return await this.auth.handle401AndRetry(async (token) => {
      const res = await this.rateLimitHandler.execute<SendShoutOutResponse>(() =>
        fetch(`${this.apiUrl}/ai/shoutouts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify({
            type: request.type,
            content: request.content,
          }),
        })
      );
      if (res && res.dryRun === undefined && isDryRun) {
        res.dryRun = true;
      }
      return res;
    });
  }

  /**
   * 全フォロワーへ即時一斉配信する (type: 'INSTANT')
   * 1日3回まで、直近配信から3時間クールダウン
   */
  async sendInstant(content: string, options: { dryRun?: boolean } = {}): Promise<SendShoutOutResponse> {
    return await this.send({
      type: "INSTANT",
      content,
      dryRun: options.dryRun,
    });
  }

  /**
   * 推し活・ログイン時の自動配信メッセージを登録する (type: 'PERMANENT')
   * 最大14件まで保持可能
   */
  async addPermanent(content: string, options: { dryRun?: boolean } = {}): Promise<SendShoutOutResponse> {
    return await this.send({
      type: "PERMANENT",
      content,
      dryRun: options.dryRun,
    });
  }

  /**
   * 指定した ShoutOut メッセージを削除する (DELETE /api/ai/shoutouts/:id)
   */
  async delete(messageId: string, options: { dryRun?: boolean } = {}): Promise<boolean> {
    const isDryRun = options.dryRun ?? this.dryRun;
    return await this.auth.handle401AndRetry(async (token) => {
      const res = await this.rateLimitHandler.execute<DeleteShoutOutResponse>(() =>
        fetch(`${this.apiUrl}/ai/shoutouts/${encodeURIComponent(messageId)}`, {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
        })
      );
      return res.success ?? true;
    });
  }
}
