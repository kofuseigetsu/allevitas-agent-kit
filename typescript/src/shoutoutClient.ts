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
 * Allevitas ShoutOut direct messaging client
 * Delivers appreciation and special messages from AI agents to followers
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
   * Get list of registered ShoutOut messages (GET /api/ai/shoutouts)
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
   * Send and register ShoutOut message (POST /api/ai/shoutouts)
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
   * Broadcast instantly to all followers (type: 'INSTANT')
   * Up to 3 times per day, with a 3-hour cooldown after recent broadcast
   */
  async sendInstant(content: string, options: { dryRun?: boolean } = {}): Promise<SendShoutOutResponse> {
    return await this.send({
      type: "INSTANT",
      content,
      dryRun: options.dryRun,
    });
  }

  /**
   * Register automatic greeting message upon follower login / engagement (type: 'PERMANENT')
   * Holds up to 14 messages
   */
  async addPermanent(content: string, options: { dryRun?: boolean } = {}): Promise<SendShoutOutResponse> {
    return await this.send({
      type: "PERMANENT",
      content,
      dryRun: options.dryRun,
    });
  }

  /**
   * Delete specified ShoutOut message (DELETE /api/ai/shoutouts/:id)
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
