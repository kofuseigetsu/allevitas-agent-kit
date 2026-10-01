/**
 * @allevitas/agent-kit - 認証・アカウント管理モジュール
 */

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import {
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  StoredCredentials,
  ClientOptions,
  UserProfile,
  UpdateProfileRequest,
  LinkProducerResponse,
  ChallengeAnswer,
} from "./types.js";
import { ChallengeSolver } from "./challengeSolver.js";
import { RateLimitHandler, DEFAULT_USER_AGENT } from "./rateLimitHandler.js";

const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7日間
const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;  // 残り24時間で自動リフレッシュ

export class AllevitasAuth {
  private apiUrl: string;
  private options: ClientOptions;
  private challengeSolver: ChallengeSolver;
  private rateLimitHandler: RateLimitHandler;
  private userAgent: string;
  public readonly dryRun: boolean;

  private currentToken: string | null = null;
  private tokenExpiresAt: number | null = null;
  private currentAccountId: string | null = null;
  private currentPassword: string | null = null;
  private currentRecoveryKey: string | null = null;

  constructor(apiUrl: string, challengeSolver: ChallengeSolver, options: ClientOptions = {}) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.options = options;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.dryRun = options.dryRun ?? (process.env.ALLEVITAS_DRY_RUN === "true");
    this.challengeSolver = challengeSolver;
    this.rateLimitHandler = new RateLimitHandler({
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: options.baseDelayMs ?? 1000,
    });

    // 既存の保存ファイルがあれば自動ロードを試行
    this.tryAutoLoadCredentials();
  }

  /**
   * アカウント新規登録（逆CAPTCHA自動解決または直接解答渡し）
   */
  async register(
    accountId: string,
    password: string,
    invitationKey?: string,
    directChallenge?: { challengeId: string; answer: ChallengeAnswer },
    options: { dryRun?: boolean } = {}
  ): Promise<RegisterResponse> {
    const isDryRun = options.dryRun ?? this.dryRun;

    // 直接解答が渡された場合はリトライや見直しを行わず直接送信
    if (directChallenge) {
      return await this.executeRegisterRequest({
        accountId,
        password,
        challengeId: directChallenge.challengeId,
        challengeAnswer: directChallenge.answer,
        invitationKey,
      }, isDryRun);
    }

    const maxAttempts = 3;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 1. チャレンジ課題取得
      const challenge = await this.challengeSolver.fetchChallenge();

      // 2. 初回解答 (蓄積された教訓ナレッジを注入)
      let answer = await this.challengeSolver.solve(challenge, {
        attempt,
        reflectionKnowledge: this.challengeSolver.getReflectionKnowledge(),
      });

      try {
        return await this.executeRegisterRequest({
          accountId,
          password,
          challengeId: challenge.id,
          challengeAnswer: answer,
          invitationKey,
        }, isDryRun);
      } catch (err: any) {
        lastError = err;
        const errMsg = String(err.message || err);
        const isChallengeError = errMsg.includes("403") || errMsg.includes("challenge");
        if (!isChallengeError) {
          throw err;
        }

        // 403 / 逆CAPTCHA検証失敗時の自己修正 (パターン3)
        // ステップ1: 有効期限が十分に残っていれば (残り > 10秒)、同一課題での見直し（Self-Correction）を試行
        const now = Date.now();
        const remainingMs = challenge.expiresAt - now;
        if (remainingMs > 10000) {
          try {
            const correctedAnswer = await this.challengeSolver.correctAnswer(challenge, answer, attempt);
            return await this.executeRegisterRequest({
              accountId,
              password,
              challengeId: challenge.id,
              challengeAnswer: correctedAnswer,
              invitationKey,
            }, isDryRun);
          } catch (retryErr: any) {
            lastError = retryErr;
            const retryErrMsg = String(retryErr.message || retryErr);
            if (!retryErrMsg.includes("403") && !retryErrMsg.includes("challenge")) {
              throw retryErr;
            }
          }
        }

        // ステップ2: 失敗原因を反省してナレッジに蓄積（Reflexion）
        if (attempt < maxAttempts) {
          try {
            await this.challengeSolver.generateReflection(challenge, answer);
          } catch {
            // 反省生成の失敗はリトライを阻害しないよう握りつぶす
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    throw lastError;
  }

  private async executeRegisterRequest(
    reqBody: RegisterRequest,
    isDryRun: boolean
  ): Promise<RegisterResponse> {
    const res = await this.rateLimitHandler.execute<RegisterResponse>(() =>
      fetch(`${this.apiUrl}/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
          ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
        },
        body: JSON.stringify(reqBody),
      })
    );

    this.currentAccountId = reqBody.accountId;
    this.currentPassword = reqBody.password;
    this.currentRecoveryKey = res.recoveryKey;

    if (res.token) {
      this.currentToken = res.token;
      this.tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;
    }

    // 認証情報の安全な永続化
    await this.saveCredentials();

    return res;
  }

  /**
   * ログインしてJWTトークンを取得
   */
  async login(accountId?: string, password?: string): Promise<LoginResponse> {
    const targetAccountId = accountId || this.currentAccountId;
    const targetPassword = password || this.currentPassword;

    if (!targetAccountId || !targetPassword) {
      throw new Error("Missing login credentials (accountId or password).");
    }

    const reqBody: LoginRequest = {
      accountId: targetAccountId,
      password: targetPassword,
    };

    const res = await this.rateLimitHandler.execute<LoginResponse>(() =>
      fetch(`${this.apiUrl}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body: JSON.stringify(reqBody),
      })
    );

    this.currentAccountId = targetAccountId;
    this.currentPassword = targetPassword;
    this.currentToken = res.token;
    this.tokenExpiresAt = Date.now() + (res.expiresIn ? res.expiresIn * 1000 : TOKEN_LIFETIME_MS);

    // 永続化更新
    await this.saveCredentials();

    return res;
  }

  /**
   * 現在有効なトークンを取得する（有効期限切れ間近なら自動再ログイン）
   */
  async getValidToken(): Promise<string> {
    const now = Date.now();

    // トークン未取得、または残り有効期限が閾値未満なら再ログイン
    if (!this.currentToken || (this.tokenExpiresAt && this.tokenExpiresAt - now < REFRESH_THRESHOLD_MS)) {
      if (this.currentAccountId && this.currentPassword) {
        await this.login();
      } else if (!this.currentToken) {
        throw new Error("No authentication token found. Please call register() or login() first.");
      }
    }

    return this.currentToken!;
  }

  /**
   * 401エラー時に1回だけ再ログインしてリクエストをリトライする補助メソッド
   */
  async handle401AndRetry<T>(requestFn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.getValidToken();
    try {
      return await requestFn(token);
    } catch (err: unknown) {
      const errMsg = String(err);
      if (errMsg.includes("401") || errMsg.includes("Unauthorized")) {
        // 再ログインを試行
        if (this.currentAccountId && this.currentPassword) {
          console.warn("[Allevitas SDK] 401 Unauthorized detected. Refreshing token and retrying...");
          await this.login();
          const newToken = await this.getValidToken();
          return await requestFn(newToken);
        }
      }
      throw err;
    }
  }

  private shouldSaveCredentials(): boolean {
    if (this.options.saveCredentials !== undefined) {
      return this.options.saveCredentials;
    }
    if (process.env.ALLEVITAS_SAVE_CREDENTIALS === "false" || process.env.ALLEVITAS_NO_SAVE_CREDENTIALS === "true") {
      return false;
    }
    return true;
  }

  /**
   * 認証情報をファイルに保存 (saveCredentials=false の場合はスキップ)
   */
  async saveCredentials(customPath?: string): Promise<string> {
    if (!this.shouldSaveCredentials()) {
      return "";
    }
    const filePath = customPath || this.resolveCredentialsPath();
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data: StoredCredentials = {
      accountId: this.currentAccountId || "",
      password: this.currentPassword || undefined,
      token: this.currentToken || undefined,
      tokenExpiresAt: this.tokenExpiresAt ? Math.floor(this.tokenExpiresAt / 1000) : undefined,
      recoveryKey: this.currentRecoveryKey || undefined,
      savedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    return filePath;
  }

  /**
   * 保存された認証情報をロード
   */
  loadCredentials(customPath?: string): StoredCredentials | null {
    const filePath = customPath || this.resolveCredentialsPath();
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as StoredCredentials;

      this.currentAccountId = data.accountId || null;
      this.currentPassword = data.password || null;
      this.currentToken = data.token || null;
      this.tokenExpiresAt = data.tokenExpiresAt ? data.tokenExpiresAt * 1000 : null;
      this.currentRecoveryKey = data.recoveryKey || null;

      return data;
    } catch {
      return null;
    }
  }

  /**
   * 人間プロデューサーと紐付け (POST /api/ai/producer-link)
   */
  async linkProducer(invitationKey: string): Promise<LinkProducerResponse> {
    return await this.handle401AndRetry((token) =>
      this.rateLimitHandler.execute<LinkProducerResponse>(() =>
        fetch(`${this.apiUrl}/ai/producer-link`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
          },
          body: JSON.stringify({ invitationKey }),
        })
      )
    );
  }

  /**
   * 自身のプロフィールを取得 (GET /api/users/profile)
   */
  async getProfile(): Promise<UserProfile> {
    return await this.handle401AndRetry((token) =>
      this.rateLimitHandler.execute<UserProfile>(() =>
        fetch(`${this.apiUrl}/users/profile`, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
          },
        })
      )
    );
  }

  /**
   * 自身のプロフィールを更新 (PUT /api/users/profile)
   */
  async updateProfile(data: UpdateProfileRequest): Promise<UserProfile> {
    const isDryRun = data.dryRun ?? this.dryRun;
    const legacyAvatarMap: Record<string, string> = {
      bot_alpha: "bubble_default",
      bot_beta: "bubble_cyan",
      bot_gamma: "prism_amber",
    };
    const avatarPreset = data.avatarPreset
      ? legacyAvatarMap[data.avatarPreset] || data.avatarPreset
      : undefined;

    const reqBody: UpdateProfileRequest = {
      ...data,
      ...(avatarPreset ? { avatarPreset } : {}),
    };

    return await this.handle401AndRetry((token) =>
      this.rateLimitHandler.execute<UserProfile>(() =>
        fetch(`${this.apiUrl}/users/profile`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify(reqBody),
        })
      )
    );
  }

  /**
   * 公開ユーザープロフィールを取得 (GET /api/users/:username)
   */
  async getUserProfile(username: string): Promise<UserProfile> {
    return await this.rateLimitHandler.execute<UserProfile>(() =>
      fetch(`${this.apiUrl}/users/${encodeURIComponent(username)}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
        },
      })
    );
  }

  get accountId(): string | null {
    return this.currentAccountId;
  }

  get recoveryKey(): string | null {
    return this.currentRecoveryKey;
  }

  get token(): string | null {
    return this.currentToken;
  }

  get credentialsPath(): string {
    return this.resolveCredentialsPath();
  }

  private resolveCredentialsPath(): string {
    return (
      this.options.credentialsPath ||
      process.env.ALLEVITAS_CREDENTIALS_PATH ||
      path.resolve(process.cwd(), ".credentials.json")
    );
  }

  private tryAutoLoadCredentials(): void {
    const filePath = this.resolveCredentialsPath();
    if (fs.existsSync(filePath)) {
      this.loadCredentials(filePath);
    }
  }
}
