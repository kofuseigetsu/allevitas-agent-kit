/**
 * @allevitas/agent-kit - レートリミット自動待機ハンドラー
 */

export interface RateLimitOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

export const DEFAULT_USER_AGENT =
  process.env.ALLEVITAS_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AllevitasSDK/1.0";

export class RateLimitHandler {
  private maxRetries: number;
  private baseDelayMs: number;
  private maxDelayMs: number;
  private onRetry?: (attempt: number, delayMs: number, reason: string) => void;

  constructor(options: RateLimitOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60000; // 最大60秒
    this.onRetry = options.onRetry;
  }

  /**
   * HTTPリクエストを実行し、429や一時的なサーバーエラー時に自動リトライする
   */
  async execute<T>(requestFn: () => Promise<Response>): Promise<T> {
    let attempt = 0;

    while (true) {
      attempt++;
      let response: Response;

      try {
        response = await requestFn();
      } catch (networkError: unknown) {
        if (attempt > this.maxRetries) {
          throw networkError;
        }
        const delay = this.calculateBackoff(attempt);
        this.notifyRetry(attempt, delay, `ネットワークエラー: ${String(networkError)}`);
        await this.sleep(delay);
        continue;
      }

      // 429 Too Many Requests
      if (response.status === 429) {
        if (attempt > this.maxRetries) {
          const bodyText = await response.text().catch(() => "");
          throw new Error(`レートリミット超過（リトライ上限 ${this.maxRetries} 回到達）: ${bodyText}`);
        }

        const retryAfterHeader = response.headers.get("retry-after");
        let waitMs = 0;

        if (retryAfterHeader) {
          const seconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(seconds)) {
            waitMs = seconds * 1000;
          }
        }

        if (waitMs === 0) {
          try {
            const body = await response.clone().json();
            if (body.retry_after_seconds) {
              waitMs = Number(body.retry_after_seconds) * 1000;
            }
          } catch {
            // JSONパース不可の場合は指数バックオフ
          }
        }

        if (waitMs === 0) {
          waitMs = this.calculateBackoff(attempt);
        } else {
          // ジッターを加算（0〜1000ms）
          waitMs += Math.floor(Math.random() * 1000);
        }

        waitMs = Math.min(waitMs, this.maxDelayMs);
        this.notifyRetry(attempt, waitMs, `429 Too Many Requests`);
        await this.sleep(waitMs);
        continue;
      }

      // 5xx サーバーエラーの一時的リトライ
      if (response.status >= 500 && response.status <= 599) {
        if (attempt > this.maxRetries) {
          const errText = await response.text().catch(() => "");
          throw new Error(`サーバーエラー ${response.status}: ${errText}`);
        }
        const delay = this.calculateBackoff(attempt);
        this.notifyRetry(attempt, delay, `サーバーエラー ${response.status}`);
        await this.sleep(delay);
        continue;
      }

      // 4xx クライアントエラー（429以外）は即座に例外
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`APIエラー [${response.status} ${response.statusText}]: ${errorBody}`);
      }

      // 2xx 成功時
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      } else {
        return (await response.text()) as unknown as T;
      }
    }
  }

  private calculateBackoff(attempt: number): number {
    const exponential = this.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 500);
    return Math.min(exponential + jitter, this.maxDelayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private notifyRetry(attempt: number, delayMs: number, reason: string): void {
    if (this.onRetry) {
      this.onRetry(attempt, delayMs, reason);
    } else {
      console.warn(`[Allevitas SDK] 再試行 (${attempt}/${this.maxRetries}): ${reason} - ${Math.round(delayMs / 1000)}秒待機中...`);
    }
  }
}
