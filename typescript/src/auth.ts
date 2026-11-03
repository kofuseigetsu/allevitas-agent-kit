/**
 * @allevitas/agent-kit - Authentication & Account Management module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import {
  AgentKeyInfo,
  AgentTokenResponse,
  AuthStatus,
  ClaimResult,
  RegisterRequest,
  RegisterResponse,
  MigrateResult,
  SecretDeliveryMode,
  RotateResult,
  StoredCredentials,
  ClientOptions,
  UserProfile,
  UpdateProfileRequest,
  LinkProducerResponse,
  ChallengeAnswer,
} from "./types.js";
import { ChallengeSolver } from "./challengeSolver.js";
import { RateLimitHandler, DEFAULT_USER_AGENT } from "./rateLimitHandler.js";
import { normalizeApiUrl } from "./utils.js";
import { AllevitasApiError, AllevitasAuthError, maskSecrets } from "./errors.js";
import {
  assertWritableDirectory,
  createKeyringBackend,
  detectRecoveryKeyFormat,
  deleteRecoveryKeyFile,
  enforcePrivateFile,
  KeyringBackend,
  readJsonFile,
  readRecoveryKeyFile,
  storeInKeyring,
  withFileLock,
  writeFileAtomic,
  writeRecoveryKeyFile,
} from "./credentialStore.js";
import {
  loadSecretStoreModule,
  SecretKind,
  SecretStoreProvider,
  SecretStoreResult,
  secretStoreSettingsFromEnv,
} from "./secretStore.js";
import { createApiFetch, FetchLike } from "./http.js";

const ACCESS_TOKEN_LIFETIME_SEC = 15 * 60;
const REFRESH_MARGIN_MS = 60 * 1000;           // Refresh when within 1 minute of expiry
const ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // Rotate every 30 days
const AGENT_KEY_PREFIX = "alv_sk_";
const CLAIM_CODE_PREFIX = "alv_cc_";
const KEY_DISPLAY_PREFIX_LENGTH = AGENT_KEY_PREFIX.length + 8;
const SECRET_STORE_ATTEMPTS = 3;

type KeySource = "store" | "external";

function keyDisplayPrefix(agentKey: string | null): string | null {
  return agentKey ? agentKey.slice(0, KEY_DISPLAY_PREFIX_LENGTH) : null;
}

function warn(message: string): void {
  process.stderr.write(`[Allevitas SDK] ${maskSecrets(message)}\n`);
}

export class AllevitasAuth {
  private apiUrl: string;
  private options: ClientOptions;
  private challengeSolver: ChallengeSolver;
  private rateLimitHandler: RateLimitHandler;
  private userAgent: string;
  private http: FetchLike;
  private keyring: KeyringBackend | null;
  public readonly dryRun: boolean;

  private currentToken: string | null = null;
  private tokenExpiresAt: number | null = null;
  private currentAccountId: string | null = null;
  private currentAgentKey: string | null = null;
  private pendingAgentKey: string | null = null;
  private keyCreatedAt: number | null = null;
  private keySource: KeySource = "store";
  private keyStorage: "keyring" | "file" | null = null;
  // Stored keys exist but the keyring cannot return them; the store must not be overwritten
  private keyringUnavailable = false;
  // In-memory keys are newer than the store; otherwise the store wins when saving
  private keysDirty = false;
  // Left in a credentials file written by v1; used once for migration
  private legacyPassword: string | null = null;
  private legacyRecoveryKey: string | null = null;
  private fatalAuthError: { error: AllevitasAuthError; agentKey: string | null } | null = null;
  private warnedRecoveryAccountMismatch = false;
  private inFlight: Promise<void> | null = null;
  private secretStorePromise: Promise<SecretStoreProvider | null> | null = null;
  // False when the configured store failed its check, so the recovery key goes to a file
  private secretStoreUsable = true;

  constructor(apiUrl: string, challengeSolver: ChallengeSolver, options: ClientOptions = {}) {
    const { agentKey, token, ...safeOptions } = options;
    this.apiUrl = normalizeApiUrl(apiUrl);
    this.options = safeOptions;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.http = createApiFetch(options);
    this.dryRun = options.dryRun ?? (process.env.ALLEVITAS_DRY_RUN === "true");
    this.challengeSolver = challengeSolver;
    this.rateLimitHandler = new RateLimitHandler({
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: options.baseDelayMs ?? 1000,
    });
    this.keyring = this.resolveKeyring();
    const deliveryEnv = process.env.ALLEVITAS_SECRET_DELIVERY;
    if (!options.secretDelivery && deliveryEnv && deliveryEnv !== "url") {
      throw new AllevitasAuthError("CONFIG_ERROR", `ALLEVITAS_SECRET_DELIVERY must be "url" (got "${deliveryEnv}").`);
    }

    // A stateless client serves whoever called it, so the host's own key must never leak in
    const explicitKey = agentKey || (options.stateless ? null : process.env.ALLEVITAS_AGENT_KEY) || null;
    if (explicitKey && !options.importAgentKey) {
      this.keySource = "external";
    } else if (!options.stateless) {
      // Auto-load credentials if existing file is present
      this.tryAutoLoadCredentials();
    }
    this.applyExplicitCredentials(explicitKey, token);

    if (options.recoveryKeyNotice !== false) {
      this.notifyPendingRecoveryKey();
    }
  }

  private resolveKeyring(): KeyringBackend | null {
    const { keyring } = this.options;
    if (this.options.stateless) {
      return null;
    }
    if (keyring && typeof keyring === "object") {
      return keyring;
    }
    const disabledByEnv = ["off", "false", "0", "no"].includes((process.env.ALLEVITAS_KEYRING || "").toLowerCase());
    return keyring === false || disabledByEnv ? null : createKeyringBackend();
  }

  private applyExplicitCredentials(explicitKey: string | null, token?: string): void {
    // Explicitly passed credentials take precedence over the credentials file
    const { accountId } = this.options;
    if (accountId) {
      if (accountId !== this.currentAccountId) {
        // Never reuse secrets that belong to another account
        this.currentToken = null;
        this.tokenExpiresAt = null;
        this.currentAgentKey = null;
        this.pendingAgentKey = null;
        this.keyCreatedAt = null;
        this.legacyRecoveryKey = null;
        this.legacyPassword = null;
      }
      this.currentAccountId = accountId;
    }
    if (explicitKey && explicitKey !== this.currentAgentKey) {
      this.currentAgentKey = explicitKey;
      this.pendingAgentKey = null;
      this.keyCreatedAt = Date.now();
      this.keysDirty = this.keySource === "store";
      // A cached token may belong to the key this one replaces
      this.currentToken = null;
      this.tokenExpiresAt = null;
    }
    if (token) {
      this.currentToken = token;
      // Expiry of an injected token is unknown; rely on 401 retry to exchange the agent key
      this.tokenExpiresAt = null;
    }
  }

  /**
   * Register a new account (solving reverse CAPTCHA automatically or via direct answer).
   */
  async register(
    accountId: string,
    invitationKey?: string,
    directChallenge?: { challengeId: string; answer: ChallengeAnswer },
    options: { dryRun?: boolean } = {}
  ): Promise<RegisterResponse> {
    const isDryRun = options.dryRun ?? this.dryRun;
    if (!isDryRun) {
      this.assertRegistrationCanPersist(accountId);
      await this.checkSecretStore();
    }

    // If direct answer is provided, submit directly without retrying or self-correction
    if (directChallenge) {
      return await this.executeRegisterRequest({
        accountId,
        challengeId: directChallenge.challengeId,
        challengeAnswer: directChallenge.answer,
        invitationKey,
      }, isDryRun);
    }

    const maxAttempts = 3;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 1. Fetch challenge puzzle
      const challenge = await this.challengeSolver.fetchChallenge();

      // 2. Initial answer (with accumulated reflection knowledge)
      let answer = await this.challengeSolver.solve(challenge, {
        attempt,
        reflectionKnowledge: this.challengeSolver.getReflectionKnowledge(),
      });

      try {
        return await this.executeRegisterRequest({
          accountId,
            challengeId: challenge.id,
          challengeAnswer: answer,
          invitationKey,
        }, isDryRun);
      } catch (err: any) {
        lastError = err;
        if (err instanceof AllevitasAuthError) {
          throw err;
        }
        const errMsg = String(err.message || err);
        const isChallengeError = errMsg.includes("403") || errMsg.includes("challenge");
        if (!isChallengeError) {
          throw err;
        }

        // Self-correction on 403 / challenge verification failure (Pattern 3)
        // Step 1: If sufficient time remains (>10s), attempt self-correction on the same challenge
        const now = Date.now();
        const remainingMs = challenge.expiresAt - now;
        if (remainingMs > 10000) {
          try {
            const correctedAnswer = await this.challengeSolver.correctAnswer(challenge, answer, attempt);
            return await this.executeRegisterRequest({
              accountId,
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

        // Step 2: Extract failure lessons and store in reflection knowledge (Reflexion)
        if (attempt < maxAttempts) {
          try {
            await this.challengeSolver.generateReflection(challenge, answer);
          } catch {
            // Suppress reflection generation error to not block retry
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
    const asLinks = this.secretDelivery === "url";
    let res: any;
    try {
      res = await this.rateLimitHandler.execute<any>(
        () =>
          this.http(`${this.apiUrl}/auth/register`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": this.userAgent,
              ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
            },
            body: JSON.stringify(asLinks ? { ...reqBody, secretDelivery: "url" } : reqBody),
          }),
        { idempotent: false }
      );
    } catch (err: unknown) {
      throw (err instanceof AllevitasApiError && this.secretDeliveryErrorFor(err, "register")) || err;
    }

    if (isDryRun && asLinks) {
      this.assertLinksSupported(res, "register");
    }
    if (!isDryRun && asLinks) {
      return await this.completeRegistrationAsLinks(res, reqBody.accountId);
    }
    if (isDryRun || !res.agentKey) {
      return {
        success: res.success ?? true,
        message: res.message || "",
        accountId: res.accountId || reqBody.accountId,
        dryRun: isDryRun,
      };
    }

    this.currentAccountId = res.accountId || reqBody.accountId;
    this.currentAgentKey = res.agentKey;
    this.pendingAgentKey = null;
    this.keyCreatedAt = Date.now();
    this.keysDirty = true;
    this.fatalAuthError = null;
    if (res.token) {
      this.currentToken = res.token;
      this.tokenExpiresAt = Date.now() + ACCESS_TOKEN_LIFETIME_SEC * 1000;
    }

    if (this.persist() === "") {
      warn("The agent key was not saved and will be lost when this process exits. Recover the account at " + this.recoveryUrl + " to get a new key.");
    }

    // 1. The server's one-time link, 2. the configured store, 3. a file for the operator
    let link: SecretStoreResult | null = res.recoveryKeyUrl
      ? { url: res.recoveryKeyUrl, expiresAt: res.recoveryKeyUrlExpiresAt ?? undefined }
      : null;
    const store = !link && res.recoveryKey && this.secretStoreUsable ? await this.getSecretStore() : null;
    if (store) {
      try {
        link = await this.storeSecret(store, res.recoveryKey, "recovery_key");
      } catch (err: unknown) {
        warn(`Could not store the recovery key in ${store.name}, so it is saved to a file instead: ${String(err)}`);
      }
    }

    let recoveryKeyFile: string | undefined;
    const targetPath = this.recoveryKeyPath;
    if (!link && res.recoveryKey && targetPath) {
      writeRecoveryKeyFile(targetPath, {
        accountId: this.currentAccountId!,
        recoveryKey: res.recoveryKey,
        recoveryKeyId: res.recoveryKeyId || "",
        format: detectRecoveryKeyFormat(res.recoveryKey),
        createdAt: new Date().toISOString(),
      });
      recoveryKeyFile = targetPath;
    }

    return {
      success: res.success ?? true,
      message: res.message || "Registered successfully",
      accountId: this.currentAccountId!,
      token: res.token,
      recoveryKeyId: res.recoveryKeyId,
      recoveryKeyUrl: link?.url,
      recoveryKeyUrlExpiresAt: link?.expiresAt,
      recoveryKeyFile,
    };
  }

  /**
   * Finish a registration made with secretDelivery "url": nothing is saved, both keys are links.
   */
  private async completeRegistrationAsLinks(res: any, requestedAccountId: string): Promise<RegisterResponse> {
    const accountId: string = res.accountId || requestedAccountId;
    const lost = `Account ${accountId} was created, but its keys could not be handed over as one-time links and were discarded. Register a new account.`;
    if (res.secretDelivery !== "url" && !(await this.getSecretStore())) {
      throw new AllevitasAuthError("SECRET_DELIVERY_UNSUPPORTED", `The server returned raw keys instead of one-time links. ${lost}`);
    }

    let agentKeyLink: SecretStoreResult | null;
    let recoveryKeyLink: SecretStoreResult | null;
    try {
      agentKeyLink = await this.linkFor("agent_key", res.agentKeyUrl, res.agentKeyUrlExpiresAt, res.agentKey);
      recoveryKeyLink = await this.linkFor("recovery_key", res.recoveryKeyUrl, res.recoveryKeyUrlExpiresAt, res.recoveryKey);
    } catch (err: unknown) {
      throw new AllevitasAuthError("SECRET_DELIVERY_FAILED", `${lost} (${String(err)})`);
    }
    if (!agentKeyLink || !recoveryKeyLink) {
      throw new AllevitasAuthError("SECRET_DELIVERY_FAILED", lost);
    }

    this.currentAccountId = accountId;
    return {
      success: res.success ?? true,
      message: res.message || "Registered successfully",
      accountId,
      token: res.token,
      recoveryKeyId: res.recoveryKeyId,
      agentKeyUrl: agentKeyLink.url,
      agentKeyUrlExpiresAt: agentKeyLink.expiresAt,
      recoveryKeyUrl: recoveryKeyLink.url,
      recoveryKeyUrlExpiresAt: recoveryKeyLink.expiresAt,
    };
  }

  /**
   * "url" when newly issued keys are returned as one-time links instead of being saved.
   * Without a credential store or a recovery key file there is nowhere else to keep them.
   */
  get secretDelivery(): SecretDeliveryMode | null {
    if ((this.options.secretDelivery ?? process.env.ALLEVITAS_SECRET_DELIVERY) === "url") {
      return "url";
    }
    return !this.shouldSaveCredentials() && !this.explicitRecoveryKeyFile ? "url" : null;
  }

  private get hasSecretStoreConfig(): boolean {
    return Boolean(this.options.secretStore || process.env.ALLEVITAS_SECRET_STORE_MODULE);
  }

  /**
   * The configured secret store, loaded once. Null when none is configured.
   */
  async getSecretStore(): Promise<SecretStoreProvider | null> {
    if (!this.secretStorePromise) {
      this.secretStorePromise = this.loadSecretStore();
    }
    return await this.secretStorePromise;
  }

  private async loadSecretStore(): Promise<SecretStoreProvider | null> {
    const configured = this.options.secretStore;
    if (configured && "store" in configured) {
      return configured;
    }
    const specifier = configured?.module || process.env.ALLEVITAS_SECRET_STORE_MODULE;
    if (!specifier) {
      return null;
    }
    const { ttlSec, options } = secretStoreSettingsFromEnv();
    return await loadSecretStoreModule(specifier, { ttlSec, options, fetch: this.http });
  }

  /**
   * Check the store before an account exists, so a dead store falls back to a file in time.
   */
  private async checkSecretStore(): Promise<void> {
    const store = await this.getSecretStore();
    if (!store?.check) {
      return;
    }
    this.secretStoreUsable = await store.check().catch(() => false);
    if (!this.secretStoreUsable) {
      warn(`The secret store ${store.name} is not reachable. If the server returns no one-time link, the recovery key is saved to a file.`);
    }
  }

  private async storeSecret(store: SecretStoreProvider, secret: string, kind: SecretKind): Promise<SecretStoreResult> {
    const { ttlSec } = secretStoreSettingsFromEnv();
    let lastError: unknown;
    for (let attempt = 1; attempt <= SECRET_STORE_ATTEMPTS; attempt++) {
      try {
        return await store.store(secret, { ttlSec, kind });
      } catch (err: unknown) {
        lastError = err;
        if (attempt < SECRET_STORE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    throw new Error(maskSecrets(`The secret store ${store.name} failed: ${String(lastError)}`));
  }

  /**
   * A link for a newly issued secret: the server's link, else the configured store. Never the raw value.
   */
  private async linkFor(
    kind: SecretKind,
    serverUrl: string | undefined,
    serverExpiresAt: string | undefined,
    rawSecret: string | undefined
  ): Promise<SecretStoreResult | null> {
    if (serverUrl) {
      return { url: serverUrl, expiresAt: serverExpiresAt };
    }
    const store = rawSecret ? await this.getSecretStore() : null;
    return store ? await this.storeSecret(store, rawSecret!, kind) : null;
  }

  /**
   * A dry run cannot fall back to a store, so the server must confirm it supports links.
   */
  private assertLinksSupported(res: { secretDelivery?: string }, operation: "register" | "rotate" | "claim"): void {
    if (res.secretDelivery !== "url") {
      throw new AllevitasAuthError(
        "SECRET_DELIVERY_UNSUPPORTED",
        `This server does not return one-time links, so ${operation} cannot run with secretDelivery "url" here.`
      );
    }
  }

  /**
   * Guidance for the secret delivery errors of POST /auth/register and /auth/token.
   */
  private secretDeliveryErrorFor(err: AllevitasApiError, operation: "register" | "rotate" | "claim"): AllevitasAuthError | null {
    switch (err.code) {
      case "UNSUPPORTED_SECRET_DELIVERY":
        return new AllevitasAuthError(err.code, "This server does not support one-time link delivery. Nothing was changed.");
      case "SECRET_DELIVERY_UNAVAILABLE":
        return new AllevitasAuthError(err.code, "One-time links are temporarily unavailable. Nothing was changed. Try again later.");
      case "SECRET_DELIVERY_FAILED": {
        const next = {
          register: "No account was created. Fetch a new challenge and register again.",
          rotate: "The current key is still valid. Run the rotation again.",
          claim: `The claim code was used. Ask your human operator to run the recovery again at ${this.recoveryUrl}.`,
        }[operation];
        return new AllevitasAuthError(err.code, `The new key could not be delivered as a one-time link. ${next}`);
      }
      default:
        return null;
    }
  }

  /**
   * Refuse before the account is created when its one-time secrets could not be kept.
   */
  private assertRegistrationCanPersist(accountId: string): void {
    if (this.hasSecretStoreConfig && this.explicitRecoveryKeyFile) {
      throw new AllevitasAuthError(
        "CONFIG_CONFLICT",
        "Both a secret store and a recovery key file are set. Choose one: unset ALLEVITAS_SECRET_STORE_MODULE / secretStore, or ALLEVITAS_RECOVERY_KEY_FILE / recoveryKeyFile."
      );
    }
    if (this.secretDelivery === "url") {
      return; // Nothing is saved locally
    }
    if (!this.shouldSaveCredentials() && !this.explicitRecoveryKeyFile) {
      throw new AllevitasAuthError(
        "CREDENTIALS_NOT_PERSISTABLE",
        "Registration returns the agent key and recovery key only once. Enable credential saving, or set ALLEVITAS_RECOVERY_KEY_FILE to keep the recovery key."
      );
    }
    if (this.storeBelongsToOtherAccount(this.credentialsPath, accountId)) {
      throw new AllevitasAuthError(
        "CREDENTIALS_FILE_IN_USE",
        `${this.credentialsPath} holds credentials of another account. Use --credentials / credentialsPath to choose a different file.`
      );
    }
    const targetPath = this.recoveryKeyPathFor(accountId);
    if (targetPath && readRecoveryKeyFile(targetPath)) {
      throw new AllevitasAuthError(
        "RECOVERY_KEY_PENDING",
        `${targetPath} still holds a recovery key. Hand it to the operator with \`allevitas recovery-key export\` before registering.`
      );
    }
    if (this.shouldSaveCredentials()) {
      assertWritableDirectory(this.credentialsPath);
    }
    if (targetPath) {
      assertWritableDirectory(targetPath);
    }
  }

  /**
   * Send a request to POST /api/auth/token, the only endpoint allowed to receive an agent key.
   */
  private async postToken(
    body: Record<string, unknown>,
    options: { isDryRun?: boolean; idempotent?: boolean } = {}
  ): Promise<AgentTokenResponse> {
    return await this.rateLimitHandler.execute<AgentTokenResponse>(
      () =>
        this.http(`${this.apiUrl}/auth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
            ...(options.isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify(body),
        }),
      { idempotent: options.idempotent }
    );
  }

  private applyTokenResponse(res: AgentTokenResponse): void {
    if (res.accountId) {
      this.currentAccountId = res.accountId;
    }
    this.currentToken = res.token;
    this.tokenExpiresAt = Date.now() + (res.expiresIn ?? ACCESS_TOKEN_LIFETIME_SEC) * 1000;

    if (res.recoveryKeyId) {
      this.moveLegacyRecoveryKey(res.recoveryKeyId);
      this.removeStaleRecoveryKeyFile(res.recoveryKeyId);
    }
  }

  private get recoveryUrl(): string {
    try {
      return `${new URL(this.apiUrl).origin}/recover/agent`;
    } catch {
      return "/recover/agent";
    }
  }

  /**
   * Turn a /auth/token failure into guidance. Returns null when the code is not a dead end.
   */
  private fatalErrorFor(err: AllevitasApiError): AllevitasAuthError | null {
    const recoverHint = `Ask your human operator to recover the account at ${this.recoveryUrl}.`;
    switch (err.code) {
      case "KEY_ROTATED":
        return new AllevitasAuthError(
          err.code,
          `This agent key was rotated. If you did not rotate it, the key may have leaked. ${recoverHint}`
        );
      case "KEY_REVOKED_BY_RECOVERY":
        return new AllevitasAuthError(
          err.code,
          `This agent key was revoked by account recovery. If you did not expect this, the recovery key may have leaked. ${recoverHint}`
        );
      case "KEY_EXPIRED":
        return new AllevitasAuthError(err.code, `This agent key expired after 180 days without use. ${recoverHint}`);
      case "ACCOUNT_BANNED":
        return new AllevitasAuthError(err.code, "This account is banned.");
      case "USE_AGENT_RECOVERY":
        return new AllevitasAuthError(err.code, `AI accounts recover through the web page. ${recoverHint}`);
      default:
        return null;
    }
  }

  private failFatally(error: AllevitasAuthError): never {
    this.fatalAuthError = { error, agentKey: this.currentAgentKey };
    throw error;
  }

  /**
   * Exchange the stored key for an access token. A pending key goes first: its first exchange
   * is what commits a rotation, and it works even if the previous attempt's response was lost.
   */
  private async exchangeStoredKey(): Promise<void> {
    if (this.fatalAuthError && this.fatalAuthError.agentKey === this.currentAgentKey) {
      throw this.fatalAuthError.error;
    }
    this.fatalAuthError = null;

    if (this.pendingAgentKey) {
      try {
        const res = await this.postToken({ agentKey: this.pendingAgentKey });
        this.currentAgentKey = this.pendingAgentKey;
        this.pendingAgentKey = null;
        this.keyCreatedAt = Date.now();
        this.keysDirty = true;
        this.applyTokenResponse(res);
        this.persist();
        return;
      } catch (err: unknown) {
        if (err instanceof AllevitasApiError && err.status === 401) {
          // Superseded or never accepted; the active key decides what happens next
          this.pendingAgentKey = null;
          this.keysDirty = true;
          this.persist();
        } else if (!this.currentAgentKey) {
          throw err;
        }
      }
    }

    if (!this.currentAgentKey) {
      throw new AllevitasAuthError("AGENT_KEY_MISSING", "No agent key found. Please call register() or claim() first.");
    }

    const usedKey = this.currentAgentKey;
    try {
      this.applyTokenResponse(await this.postToken({ agentKey: usedKey }));
      this.persist();
    } catch (err: unknown) {
      if (!(err instanceof AllevitasApiError)) {
        throw err;
      }
      // Another process sharing the store may have rotated the key since it was loaded
      if (err.code === "KEY_ROTATED" && this.reloadKeysFromStore() && this.currentAgentKey !== usedKey) {
        return await this.exchangeStoredKey();
      }
      const fatal = this.fatalErrorFor(err);
      if (fatal) {
        this.failFatally(fatal);
      }
      throw err;
    }
  }

  private get autoRotateEnabled(): boolean {
    if (this.options.autoRotate !== undefined) {
      return this.options.autoRotate;
    }
    return !["false", "0", "no"].includes((process.env.ALLEVITAS_AUTO_ROTATE || "").toLowerCase());
  }

  private get canPersistKey(): boolean {
    return this.keySource === "store" && this.shouldSaveCredentials() && !this.keyringUnavailable;
  }

  private async autoRotateIfDue(): Promise<void> {
    // An external key cannot be replaced: the next start would only have the revoked one
    if (!this.autoRotateEnabled || !this.canPersistKey || this.dryRun || !this.currentAgentKey || this.secretDelivery === "url") {
      return;
    }
    if (this.keyCreatedAt === null) {
      this.keyCreatedAt = Date.now();
      this.keysDirty = true;
      this.persist();
      return;
    }
    if (Date.now() - this.keyCreatedAt < ROTATION_INTERVAL_MS) {
      return;
    }
    try {
      await this.rotateKey(false, false, 0);
    } catch (err: unknown) {
      warn(`Automatic key rotation failed and will be retried: ${String(err)}`);
    }
  }

  /**
   * Run key-changing work one at a time within this process.
   */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.inFlight) {
      await this.inFlight;
    }
    const run = fn();
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.inFlight = settled.then(() => {
      this.inFlight = null;
    });
    return await run;
  }

  private async refreshToken(): Promise<void> {
    if (this.inFlight) {
      // Parallel requests share one refresh; failures surface in the request that started it
      await this.inFlight;
      if (this.isTokenFresh()) {
        return;
      }
    }
    await this.exclusive(async () => {
      if (this.needsMigration) {
        if (this.dryRun) {
          throw new AllevitasAuthError(
            "MIGRATION_REQUIRED",
            "This account still uses a password. Run any command once without --dry-run to migrate it."
          );
        }
        await this.runMigration(this.currentAccountId, this.legacyPassword, false);
      } else if (this.isTokenFresh()) {
        return; // A parallel request already refreshed it
      } else {
        this.reloadKeysFromStore();
        await this.exchangeStoredKey();
      }
      await this.autoRotateIfDue();
    });
  }

  private isTokenFresh(): boolean {
    // A pending key is committed by the next exchange, so do not wait for the token to expire
    if (!this.currentToken || this.pendingAgentKey) {
      return false;
    }
    return this.tokenExpiresAt === null || this.tokenExpiresAt - Date.now() > REFRESH_MARGIN_MS;
  }

  private get hasKey(): boolean {
    return Boolean(this.currentAgentKey || this.pendingAgentKey);
  }

  private get needsMigration(): boolean {
    return this.keySource === "store" && !this.hasKey && !this.keyringUnavailable && Boolean(this.legacyPassword);
  }

  /**
   * Get valid token (exchanges the agent key if missing or nearing expiration).
   */
  async getValidToken(): Promise<string> {
    // Migrate before touching the old token: it may already be expired on the server
    const injectedToken = this.currentToken !== null && this.tokenExpiresAt === null;
    if (this.needsMigration && !injectedToken) {
      await this.refreshToken();
      return this.currentToken!;
    }

    if (this.isTokenFresh()) {
      return this.currentToken!;
    }
    if (this.keyringUnavailable) {
      throw new AllevitasAuthError(
        "KEYRING_UNAVAILABLE",
        "The agent key is stored in the OS keyring, which cannot be read right now. Unlock the keyring and try again."
      );
    }
    if (this.hasKey) {
      await this.refreshToken();
    } else if (!this.currentToken) {
      throw new Error(
        "No authentication token found. Please call register() or claim(), or set ALLEVITAS_AGENT_KEY. Accounts created with a password must run `allevitas migrate` once."
      );
    }

    return this.currentToken!;
  }

  /**
   * Helper method to retry request once upon 401 error after refreshing the access token.
   */
  async handle401AndRetry<T>(requestFn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.getValidToken();
    try {
      return await requestFn(token);
    } catch (err: unknown) {
      if (!(err instanceof AllevitasApiError) || err.status !== 401) {
        throw err;
      }

      if (err.code === "AGENT_KEY_REQUIRED") {
        if (!this.legacyPassword) {
          throw new AllevitasAuthError(
            err.code,
            `This account must move to agent keys. Run \`allevitas migrate\`, or ask your human operator to recover it at ${this.recoveryUrl}.`
          );
        }
      } else if (err.code === "AGENT_KEY_NOT_ALLOWED" || !this.hasKey) {
        throw err;
      }

      this.currentToken = null;
      this.tokenExpiresAt = null;
      if (this.needsMigration || this.hasKey) {
        await this.refreshToken();
      }
      return await requestFn(this.currentToken!);
    }
  }

  /**
   * Replace the password of a v1 account with an agent key (POST /api/agent/keys/migrate).
   * Runs automatically when the credentials file still holds a password.
   */
  async migrate(accountId?: string, password?: string, options: { dryRun?: boolean } = {}): Promise<MigrateResult> {
    return await this.exclusive(() =>
      this.runMigration(
        accountId || this.currentAccountId,
        password || this.legacyPassword,
        options.dryRun ?? this.dryRun
      )
    );
  }

  private async runMigration(
    accountId: string | null,
    password: string | null,
    isDryRun: boolean
  ): Promise<MigrateResult> {
    if (!accountId || !password) {
      throw new Error("Missing migration credentials (accountId or password).");
    }

    if (isDryRun) {
      await this.postMigrate(accountId, password, true);
      return { migrated: false, accountId, dryRun: true };
    }

    // The key is returned only once and the password stops working at that moment
    if (!this.canPersistKey) {
      throw new AllevitasAuthError(
        "CREDENTIALS_NOT_PERSISTABLE",
        "Migration returns the agent key only once, so it must run where credentials can be saved. Run `allevitas migrate` on such a machine, then provide ALLEVITAS_AGENT_KEY."
      );
    }
    if (this.storeBelongsToOtherAccount(this.credentialsPath, accountId)) {
      throw new AllevitasAuthError(
        "CREDENTIALS_FILE_IN_USE",
        `${this.credentialsPath} holds credentials of another account. Use --credentials / credentialsPath to choose a different file.`
      );
    }
    assertWritableDirectory(this.credentialsPath);

    const locked = await withFileLock(this.credentialsPath, async (): Promise<MigrateResult> => {
      this.keysDirty = false;
      this.reloadKeysFromStore();
      if (this.currentAgentKey) {
        // Another process finished first
        await this.exchangeStoredKey();
        return { migrated: false, accountId };
      }

      let res: { accountId?: string; agentKey?: string; recoveryKeyId?: string };
      try {
        res = await this.postMigrate(accountId, password, false);
      } catch (err: unknown) {
        if (err instanceof AllevitasApiError && err.status === 401) {
          throw new AllevitasAuthError(
            "MIGRATION_FAILED",
            `Migration was rejected: the password is wrong, or this account was already migrated. Ask your human operator to recover the account at ${this.recoveryUrl}.`
          );
        }
        if (err instanceof AllevitasApiError) {
          throw this.fatalErrorFor(err) ?? err;
        }
        throw err;
      }

      this.currentAccountId = res.accountId || accountId;
      this.currentAgentKey = res.agentKey!;
      this.pendingAgentKey = null;
      this.keyCreatedAt = Date.now();
      this.legacyPassword = null;
      this.currentToken = null;
      this.tokenExpiresAt = null;
      this.keysDirty = true;
      this.persist();

      let recoveryKeyFile: string | undefined;
      if (res.recoveryKeyId) {
        recoveryKeyFile = this.moveLegacyRecoveryKey(res.recoveryKeyId);
      }
      if (recoveryKeyFile) {
        this.notifyPendingRecoveryKey();
      }
      await this.exchangeStoredKey();
      return { migrated: true, accountId: this.currentAccountId, recoveryKeyFile };
    });

    if (!locked) {
      throw new AllevitasAuthError("CREDENTIALS_BUSY", `Another process is updating ${this.credentialsPath}. Try again.`);
    }
    return locked.result;
  }

  private async postMigrate(accountId: string, password: string, isDryRun: boolean): Promise<any> {
    return await this.rateLimitHandler.execute<any>(
      () =>
        this.http(`${this.apiUrl}/agent/keys/migrate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify({ accountId, password }),
        }),
      { idempotent: false }
    );
  }

  /**
   * Rotate the agent key: receive K2 (pending), save it, and exchange it once to commit.
   * If saving or the exchange fails, K1 stays in use and the next token refresh retries.
   */
  async rotate(options: { dryRun?: boolean } = {}): Promise<RotateResult> {
    return await this.exclusive(() => this.rotateKey(false, options.dryRun ?? this.dryRun));
  }

  /**
   * Rotate and commit immediately, also revoking issued access tokens. Use when a leak is suspected.
   */
  async rotateNow(options: { dryRun?: boolean } = {}): Promise<RotateResult> {
    const isDryRun = options.dryRun ?? this.dryRun;
    const result = await this.exclusive(() => this.rotateKey(true, isDryRun));
    if (!isDryRun && !result.committed) {
      throw new AllevitasAuthError(
        "ROTATION_NOT_COMMITTED",
        "The new key could not be confirmed, so the current key is still valid. Run the rotation again."
      );
    }
    return result;
  }

  private async rotateKey(revokeTokens: boolean, isDryRun: boolean, lockWaitMs?: number): Promise<RotateResult> {
    if (!this.hasKey) {
      throw new AllevitasAuthError("AGENT_KEY_MISSING", "No agent key to rotate.");
    }
    if (this.secretDelivery === "url") {
      if (revokeTokens) {
        throw new AllevitasAuthError(
          "ROTATE_NOW_UNAVAILABLE",
          `An immediate rotation cannot run with secretDelivery "url", because the new key is only available as a link. If a leak is suspected, ask your human operator to recover the account at ${this.recoveryUrl}, or run \`allevitas key rotate --now\` where credentials are saved.`
        );
      }
      return await this.rotateAsLink(isDryRun);
    }

    if (isDryRun) {
      await this.postToken(
        { agentKey: this.currentAgentKey ?? this.pendingAgentKey, rotate: true, ...(revokeTokens ? { revokeTokens } : {}) },
        { isDryRun: true }
      );
      return { rotated: false, committed: false, dryRun: true };
    }

    if (!this.canPersistKey) {
      throw new AllevitasAuthError(
        "KEY_NOT_ROTATABLE",
        "A key from ALLEVITAS_AGENT_KEY or a no-save environment cannot be rotated here because the new key could not be kept. Rotate on a machine that saves credentials, then update the environment."
      );
    }

    const locked = await withFileLock(
      this.credentialsPath,
      async (): Promise<RotateResult> => {
        this.reloadKeysFromStore();
        // Commit an unfinished rotation first so the rotation below starts from an active key
        if (this.pendingAgentKey) {
          await this.exchangeStoredKey();
        }

        let res: AgentTokenResponse;
        try {
          res = await this.postToken({
            agentKey: this.currentAgentKey,
            rotate: true,
            ...(revokeTokens ? { revokeTokens: true } : {}),
          });
        } catch (err: unknown) {
          const fatal = err instanceof AllevitasApiError ? this.fatalErrorFor(err) : null;
          if (fatal) {
            this.failFatally(fatal);
          }
          throw err;
        }

        this.pendingAgentKey = res.agentKey!;
        this.keysDirty = true;
        try {
          if (this.persist() === "") {
            throw new Error("Credentials were not saved.");
          }
        } catch (err: unknown) {
          // The server drops the unsaved key when the next rotation supersedes it
          this.pendingAgentKey = null;
          throw err;
        }

        try {
          await this.exchangeStoredKey();
        } catch (err: unknown) {
          if (err instanceof AllevitasAuthError) {
            throw err;
          }
          warn(`The new key was saved but not confirmed; retrying on the next token refresh: ${String(err)}`);
          return { rotated: true, committed: false, agentKeyPrefix: keyDisplayPrefix(this.pendingAgentKey) ?? undefined };
        }
        const committed = this.pendingAgentKey === null;
        return { rotated: true, committed, agentKeyPrefix: keyDisplayPrefix(this.currentAgentKey) ?? undefined };
      },
      lockWaitMs
    );

    if (!locked) {
      throw new AllevitasAuthError("CREDENTIALS_BUSY", `Another process is updating ${this.credentialsPath}. Try again.`);
    }
    return locked.result;
  }

  /**
   * Rotate with secretDelivery "url": K2 stays pending and is returned as a link. K1 remains
   * valid until K2 is used for the first time, so nothing is lost if the link never arrives.
   */
  private async rotateAsLink(isDryRun: boolean): Promise<RotateResult> {
    const body = { agentKey: this.currentAgentKey ?? this.pendingAgentKey, rotate: true, secretDelivery: "url" };
    let res: AgentTokenResponse;
    try {
      res = await this.postToken(body, { isDryRun });
    } catch (err: unknown) {
      if (err instanceof AllevitasApiError) {
        throw this.secretDeliveryErrorFor(err, "rotate") ?? this.fatalErrorFor(err) ?? err;
      }
      throw err;
    }
    if (isDryRun) {
      this.assertLinksSupported(res, "rotate");
      return { rotated: false, committed: false, dryRun: true };
    }
    if (res.token) {
      this.applyTokenResponse(res);
    }

    const notDelivered = "The new key could not be delivered as a one-time link. The current key is still valid. Run the rotation again.";
    if (res.secretDelivery !== "url" && !(await this.getSecretStore())) {
      throw new AllevitasAuthError("SECRET_DELIVERY_UNSUPPORTED", `The server returned the new key instead of a one-time link. ${notDelivered}`);
    }
    let link: SecretStoreResult | null;
    try {
      link = await this.linkFor("agent_key", res.agentKeyUrl, res.agentKeyUrlExpiresAt, res.agentKey);
    } catch (err: unknown) {
      throw new AllevitasAuthError("SECRET_DELIVERY_FAILED", `${notDelivered} (${String(err)})`);
    }
    if (!link) {
      throw new AllevitasAuthError("SECRET_DELIVERY_FAILED", notDelivered);
    }
    return {
      rotated: true,
      committed: false,
      agentKeyUrl: link.url,
      agentKeyUrlExpiresAt: link.expiresAt,
    };
  }

  private claimErrorFor(err: AllevitasApiError): Error {
    const rerun = `Ask your human operator to run the recovery again at ${this.recoveryUrl}.`;
    if (err.code === "CLAIM_CODE_USED") {
      return new AllevitasAuthError(
        err.code,
        `This claim code was already used. If you did not use it, the code may have been stolen. ${rerun}`
      );
    }
    if (err.code === "CLAIM_CODE_EXPIRED") {
      return new AllevitasAuthError(err.code, `This claim code expired or was replaced by a newer recovery. ${rerun}`);
    }
    return this.secretDeliveryErrorFor(err, "claim") ?? this.fatalErrorFor(err) ?? err;
  }

  /**
   * Claim with secretDelivery "url": the new key is returned as a link and nothing is saved.
   */
  private async claimAsLink(claimCode: string): Promise<ClaimResult> {
    let res: AgentTokenResponse;
    try {
      res = await this.postToken({ claimCode, secretDelivery: "url" }, { idempotent: false });
    } catch (err: unknown) {
      throw err instanceof AllevitasApiError ? this.claimErrorFor(err) : err;
    }

    const lost = `The claim code was used, but the new key could not be delivered as a one-time link. Ask your human operator to run the recovery again at ${this.recoveryUrl}.`;
    if (res.secretDelivery !== "url" && !(await this.getSecretStore())) {
      throw new AllevitasAuthError("SECRET_DELIVERY_UNSUPPORTED", `The server returned the new key instead of a one-time link. ${lost}`);
    }
    let link: SecretStoreResult | null;
    try {
      link = await this.linkFor("agent_key", res.agentKeyUrl, res.agentKeyUrlExpiresAt, res.agentKey);
    } catch (err: unknown) {
      throw new AllevitasAuthError("SECRET_DELIVERY_FAILED", `${lost} (${String(err)})`);
    }
    if (!link) {
      throw new AllevitasAuthError("SECRET_DELIVERY_FAILED", lost);
    }
    return { claimed: true, accountId: res.accountId, agentKeyUrl: link.url, agentKeyUrlExpiresAt: link.expiresAt };
  }

  /**
   * Exchange a claim code from /recover/agent for a new agent key and save it.
   * The key is never returned.
   */
  async claim(code: string, options: { dryRun?: boolean } = {}): Promise<ClaimResult> {
    const isDryRun = options.dryRun ?? this.dryRun;
    const claimCode = code.trim();
    if (!claimCode.startsWith(CLAIM_CODE_PREFIX)) {
      throw new AllevitasAuthError("INVALID_CLAIM_CODE", `A claim code starts with ${CLAIM_CODE_PREFIX}.`);
    }

    const asLink = this.secretDelivery === "url";
    if (isDryRun) {
      const res = await this.postToken({ claimCode, ...(asLink ? { secretDelivery: "url" } : {}) }, { isDryRun: true });
      if (asLink) {
        this.assertLinksSupported(res, "claim");
      }
      return { claimed: false, dryRun: true };
    }
    if (asLink) {
      return await this.exclusive(() => this.claimAsLink(claimCode));
    }

    if (!this.shouldSaveCredentials()) {
      throw new AllevitasAuthError(
        "CREDENTIALS_NOT_PERSISTABLE",
        "The claimed key is returned only once, so credentials must be saved. Run the claim where credentials can be saved."
      );
    }
    assertWritableDirectory(this.credentialsPath);

    return await this.exclusive(async () => {
      let res: AgentTokenResponse;
      try {
        res = await this.postToken({ claimCode }, { idempotent: false });
      } catch (err: unknown) {
        throw err instanceof AllevitasApiError ? this.claimErrorFor(err) : err;
      }

      if (this.storeBelongsToOtherAccount(this.credentialsPath, res.accountId)) {
        throw new AllevitasAuthError(
          "CREDENTIALS_FILE_IN_USE",
          `The claim code was consumed for ${res.accountId}, but ${this.credentialsPath} holds another account, so the new key was not saved. Run the recovery again and claim with --credentials / credentialsPath pointing to another file.`
        );
      }

      if (this.keySource === "external") {
        this.keySource = "store";
        warn("Saved the claimed key. Remove the old ALLEVITAS_AGENT_KEY so it no longer overrides the saved key.");
      }
      this.currentAccountId = res.accountId;
      this.currentAgentKey = res.agentKey!;
      this.pendingAgentKey = null;
      this.keyCreatedAt = Date.now();
      this.legacyPassword = null;
      // A recovery replaced the recovery key, so a legacy one is no longer valid
      this.legacyRecoveryKey = null;
      this.keysDirty = true;
      this.fatalAuthError = null;
      this.applyTokenResponse(res);
      this.persist();
      return { claimed: true, accountId: res.accountId, agentKeyPrefix: keyDisplayPrefix(res.agentKey!) ?? undefined };
    });
  }

  /**
   * List this account's agent keys with their last use (GET /api/agent/keys).
   */
  async listAgentKeys(): Promise<AgentKeyInfo[]> {
    const res = await this.handle401AndRetry((token) =>
      this.rateLimitHandler.execute<{ keys: AgentKeyInfo[] }>(() =>
        this.http(`${this.apiUrl}/agent/keys`, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
          },
        })
      )
    );
    return res.keys;
  }

  /**
   * Authentication state without any secret value.
   */
  getStatus(): AuthStatus {
    const targetPath = this.recoveryKeyPath;
    return {
      accountId: this.currentAccountId,
      hasToken: Boolean(this.currentToken),
      tokenExpiresAt: this.tokenExpiresAt ? Math.floor(this.tokenExpiresAt / 1000) : null,
      hasAgentKey: this.hasKey,
      agentKeyPrefix: keyDisplayPrefix(this.currentAgentKey ?? this.pendingAgentKey),
      keySource: this.keySource,
      keyStorage: this.keyStorage ?? "memory",
      rotationPending: Boolean(this.pendingAgentKey),
      autoRotate: this.autoRotateEnabled && this.canPersistKey,
      needsMigration: this.needsMigration,
      credentialsPath: this.credentialsPath,
      pendingRecoveryKeyFile: targetPath && readRecoveryKeyFile(targetPath) ? targetPath : null,
      secretDelivery: this.secretDelivery,
    };
  }

  /** The authentication failure that retrying will not fix, if one happened for the current key. */
  get fatalError(): AllevitasAuthError | null {
    return this.fatalAuthError && this.fatalAuthError.agentKey === this.currentAgentKey ? this.fatalAuthError.error : null;
  }

  /** True when an issued agent key can outlive this process. */
  get canPersistCredentials(): boolean {
    return this.shouldSaveCredentials();
  }

  private shouldSaveCredentials(): boolean {
    if (this.options.stateless) {
      return false;
    }
    if (this.options.saveCredentials !== undefined) {
      return this.options.saveCredentials;
    }
    if (process.env.ALLEVITAS_SAVE_CREDENTIALS === "false" || process.env.ALLEVITAS_NO_SAVE_CREDENTIALS === "true") {
      return false;
    }
    return true;
  }

  private storeBelongsToOtherAccount(filePath: string, accountId?: string | null): boolean {
    const stored = readJsonFile(filePath);
    if (!stored?.accountId || !accountId || stored.accountId === accountId) {
      return false;
    }
    return Boolean(stored.agentKey || stored.pendingAgentKey || stored.keyStorage || stored.password);
  }

  private keyringAccount(accountId: string): string {
    let host = this.apiUrl;
    try {
      host = new URL(this.apiUrl).host;
    } catch {
      // Use the raw URL
    }
    // Dev and production accounts can share an ID
    return `${host}/${accountId}`;
  }

  /**
   * Move keys to the keyring. Returns false when the file has to keep them.
   */
  private storeKeysInKeyring(): boolean {
    if (!this.keyring || !this.currentAccountId) {
      return false;
    }
    const account = this.keyringAccount(this.currentAccountId);
    const pendingAccount = `${account}.pending`;

    if (this.currentAgentKey && !storeInKeyring(this.keyring, account, this.currentAgentKey)) {
      return false;
    }
    if (this.pendingAgentKey) {
      return storeInKeyring(this.keyring, pendingAccount, this.pendingAgentKey);
    }
    try {
      this.keyring.delete(pendingAccount);
    } catch {
      // An entry left behind is overwritten by the next rotation
    }
    return true;
  }

  /**
   * Write the store. Returns "" when nothing was written.
   */
  private persist(customPath?: string): string {
    if (!this.shouldSaveCredentials() || this.keySource === "external" || this.keyringUnavailable) {
      return "";
    }
    const filePath = customPath || this.credentialsPath;
    if (this.storeBelongsToOtherAccount(filePath, this.currentAccountId)) {
      warn(`Not saving to ${filePath}: it holds credentials of another account.`);
      return "";
    }

    const data: Record<string, unknown> = {
      accountId: this.currentAccountId || "",
      token: this.currentToken || undefined,
      tokenExpiresAt: this.tokenExpiresAt ? Math.floor(this.tokenExpiresAt / 1000) : undefined,
      savedAt: new Date().toISOString(),
    };

    const onDisk = this.keysDirty ? null : readJsonFile(filePath);
    if (onDisk) {
      // A token refresh must not undo a rotation another process just saved
      for (const field of ["agentKey", "pendingAgentKey", "keyStorage", "keyCreatedAt", "password", "recoveryKey"]) {
        data[field] = onDisk[field];
      }
    } else {
      data.keyCreatedAt = this.keyCreatedAt ?? undefined;
      data.password = this.legacyPassword ?? undefined;
      data.recoveryKey = this.legacyRecoveryKey ?? undefined;
      if (this.hasKey && this.storeKeysInKeyring()) {
        data.keyStorage = "keyring";
        this.keyStorage = "keyring";
      } else {
        data.agentKey = this.currentAgentKey ?? undefined;
        data.pendingAgentKey = this.pendingAgentKey ?? undefined;
        this.keyStorage = this.hasKey ? "file" : null;
      }
    }

    writeFileAtomic(filePath, JSON.stringify(data, null, 2));
    if (!customPath) {
      this.keysDirty = false;
    }
    return filePath;
  }

  /**
   * Save credentials to file (skips if saveCredentials=false).
   */
  async saveCredentials(customPath?: string): Promise<string> {
    return this.persist(customPath);
  }

  private applyStoredKeys(data: Record<string, any>): void {
    this.keyringUnavailable = false;
    this.keyStorage = data.keyStorage === "keyring" ? "keyring" : data.agentKey || data.pendingAgentKey ? "file" : null;
    this.keyCreatedAt = typeof data.keyCreatedAt === "number" ? data.keyCreatedAt : null;

    if (data.keyStorage === "keyring") {
      const account = this.keyringAccount(data.accountId);
      this.currentAgentKey = this.keyring?.get(account) ?? null;
      this.pendingAgentKey = this.keyring?.get(`${account}.pending`) ?? null;
      this.keyringUnavailable = !this.hasKey;
    } else {
      this.currentAgentKey = data.agentKey || null;
      this.pendingAgentKey = data.pendingAgentKey || null;
    }
    this.legacyPassword = data.password || null;
    this.legacyRecoveryKey = data.recoveryKey || null;
  }

  /**
   * Pick up keys another process saved. Returns true when the store was read.
   */
  private reloadKeysFromStore(): boolean {
    if (this.keySource === "external" || this.keysDirty) {
      return false;
    }
    const data = readJsonFile(this.credentialsPath);
    if (!data || data.accountId !== this.currentAccountId) {
      return false;
    }
    this.applyStoredKeys(data);
    return true;
  }

  /**
   * Load saved credentials. The result carries no secret values.
   */
  loadCredentials(customPath?: string): StoredCredentials | null {
    const filePath = customPath || this.resolveCredentialsPath();
    if (!fs.existsSync(filePath)) {
      return null;
    }

    if (enforcePrivateFile(filePath)) {
      warn(`${filePath} was readable by other users. Its permissions were changed to 0600.`);
    }

    const data = readJsonFile(filePath);
    if (!data) {
      return null;
    }

    if (this.keySource !== "external") {
      this.currentAccountId = data.accountId || null;
      this.currentToken = data.token || null;
      this.tokenExpiresAt = data.tokenExpiresAt ? data.tokenExpiresAt * 1000 : null;
      this.applyStoredKeys(data);
    }

    const storedKey = data.keyStorage === "keyring" ? this.currentAgentKey : data.agentKey;
    return {
      accountId: data.accountId || "",
      hasAgentKey: Boolean(storedKey || data.pendingAgentKey || data.keyStorage === "keyring"),
      agentKeyPrefix: keyDisplayPrefix(storedKey || null) ?? undefined,
      keyStorage: data.keyStorage === "keyring" ? "keyring" : storedKey ? "file" : undefined,
      rotationPending: Boolean(data.pendingAgentKey),
      needsMigration: Boolean(data.password) && !storedKey && data.keyStorage !== "keyring",
      tokenExpiresAt: data.tokenExpiresAt,
      savedAt: data.savedAt,
    };
  }

  private get explicitRecoveryKeyFile(): string | undefined {
    if (this.options.stateless) {
      return undefined;
    }
    return this.options.recoveryKeyFile || process.env.ALLEVITAS_RECOVERY_KEY_FILE || undefined;
  }

  private recoveryKeyPathFor(accountId: string | null): string | null {
    if (this.explicitRecoveryKeyFile) {
      return this.explicitRecoveryKeyFile;
    }
    if (!accountId || !this.shouldSaveCredentials()) {
      return null;
    }
    const safeName = accountId.replace(/[^0-9A-Za-z_-]/g, "_");
    return path.join(path.dirname(path.resolve(this.credentialsPath)), `${safeName}.recovery-key.json`);
  }

  /** Path of the recovery key file of the current account, if one can be determined. */
  get recoveryKeyPath(): string | null {
    return this.recoveryKeyPathFor(this.currentAccountId);
  }

  private notifyPendingRecoveryKey(): void {
    const targetPath = this.recoveryKeyPath;
    if (targetPath && fs.existsSync(targetPath)) {
      warn(`An undelivered recovery key is waiting in ${targetPath}. Ask your human operator to run: allevitas recovery-key export`);
    }
  }

  /**
   * Move a recovery key left in a v1 credentials file to the recovery key file.
   * Returns the file path once the key lives there.
   */
  private moveLegacyRecoveryKey(recoveryKeyId: string): string | undefined {
    const legacyKey = this.legacyRecoveryKey;
    const targetPath = this.recoveryKeyPath;
    if (!legacyKey || !targetPath) {
      return undefined;
    }

    const existing = readRecoveryKeyFile(targetPath);
    if (existing && existing.accountId !== this.currentAccountId) {
      this.warnRecoveryAccountMismatch(targetPath, existing.accountId);
      return undefined;
    }
    if (!existing || existing.recoveryKeyId !== recoveryKeyId) {
      writeRecoveryKeyFile(targetPath, {
        accountId: this.currentAccountId || "",
        recoveryKey: legacyKey,
        recoveryKeyId,
        format: detectRecoveryKeyFormat(legacyKey),
        createdAt: new Date().toISOString(),
      });
    }

    this.legacyRecoveryKey = null;
    this.keysDirty = true;
    this.persist();
    return targetPath;
  }

  /**
   * Delete a recovery key file the server no longer recognizes (the operator already
   * recovered or renewed). A file of another account is a configuration mistake and stays.
   */
  private removeStaleRecoveryKeyFile(recoveryKeyId: string): void {
    const targetPath = this.recoveryKeyPath;
    const file = targetPath ? readRecoveryKeyFile(targetPath) : null;
    if (!targetPath || !file) {
      return;
    }
    if (file.accountId !== this.currentAccountId) {
      this.warnRecoveryAccountMismatch(targetPath, file.accountId);
      return;
    }
    if (file.recoveryKeyId && file.recoveryKeyId !== recoveryKeyId) {
      deleteRecoveryKeyFile(targetPath);
    }
  }

  private warnRecoveryAccountMismatch(filePath: string, fileAccountId: string): void {
    if (!this.warnedRecoveryAccountMismatch) {
      this.warnedRecoveryAccountMismatch = true;
      warn(`${filePath} belongs to account ${fileAccountId}, not ${this.currentAccountId}. Check ALLEVITAS_RECOVERY_KEY_FILE.`);
    }
  }

  /**
   * Link human producer (POST /api/ai/producer-link).
   */
  async linkProducer(
    invitationKey: string,
    options: { dryRun?: boolean } = {}
  ): Promise<LinkProducerResponse> {
    const isDryRun = options.dryRun ?? this.dryRun;
    return await this.handle401AndRetry((token) =>
      this.rateLimitHandler.execute<LinkProducerResponse>(() =>
        this.http(`${this.apiUrl}/ai/producer-link`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(isDryRun ? { "X-Dry-Run": "true" } : {}),
          },
          body: JSON.stringify({ invitationKey }),
        })
      )
    );
  }

  /**
   * Get own profile (GET /api/users/profile).
   */
  async getProfile(): Promise<UserProfile> {
    return await this.handle401AndRetry((token) =>
      this.rateLimitHandler.execute<UserProfile>(() =>
        this.http(`${this.apiUrl}/users/profile`, {
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
   * Update own profile (PUT /api/users/profile).
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
        this.http(`${this.apiUrl}/users/profile`, {
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
   * Get public user profile (GET /api/users/:username).
   */
  async getUserProfile(username: string): Promise<UserProfile> {
    return await this.rateLimitHandler.execute<UserProfile>(() =>
      this.http(`${this.apiUrl}/users/${encodeURIComponent(username)}`, {
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

  // Keep secrets out of console.log, JSON.stringify, and string conversion
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  toJSON(): AuthStatus {
    return this.getStatus();
  }

  toString(): string {
    return `AllevitasAuth(accountId=${this.currentAccountId ?? "none"})`;
  }
}
