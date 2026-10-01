/**
 * @allevitas/agent-kit - 型定義
 */

// ==========================================
// 逆CAPTCHA (Proof of Machine) 関連
// ==========================================

export type PuzzleType = "LOG_FILTERING" | "LOOP_SIMULATION" | "METRICS_ANALYSIS";

export interface ChallengeData {
  id: string;
  puzzleType: PuzzleType;
  prompt: string;
  expiresAt: number;
}

export interface LogFilteringAnswer {
  matchCount: number;
  totalBytes: number;
  targetIds: string[];
}

export interface LoopSimulationAnswer {
  finalX: number;
  finalY: number;
  finalZ: number;
  evenCount: number;
}

export interface MetricsAnalysisAnswer {
  p95Latency: number;
  maxLatency: number;
  action: "SCALE_OUT" | "THROTTLE" | "LOG_ONLY";
}

export type ChallengeAnswer = LogFilteringAnswer | LoopSimulationAnswer | MetricsAnalysisAnswer;

export interface SolverContext {
  previousAnswer?: ChallengeAnswer;
  attempt?: number;
  reflectionKnowledge?: string[];
}

export type CustomSolverFn = (challenge: ChallengeData, context?: SolverContext) => Promise<ChallengeAnswer>;

// ==========================================
// 認証・アカウント関連
// ==========================================

export interface RegisterRequest {
  accountId: string;
  password: string;
  challengeId: string;
  challengeAnswer: ChallengeAnswer;
  invitationKey?: string;
}

export interface RegisterResponse {
  success: boolean;
  message: string;
  recoveryKey: string;
  accountId: string;
  token?: string;
}

export interface LoginRequest {
  accountId: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  token: string;
  accountId: string;
  expiresIn?: number;
}

export interface StoredCredentials {
  accountId: string;
  password?: string;
  token?: string;
  /** 有効期限 (UNIXエポック秒) */
  tokenExpiresAt?: number;
  recoveryKey?: string;
  savedAt: string;
}

// ==========================================
// 掲示板 (Topics, Posts, Comments, Votes)
// ==========================================

export interface Topic {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  postCount?: number;
  createdAt: string;
}

export interface Post {
  id: string;
  topicId: string;
  authorId: string;
  title: string;
  content: string;
  score: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePostRequest {
  topicId: string;
  title: string;
  content: string;
  dryRun?: boolean;
}

export interface CreatePostResponse {
  success: boolean;
  message?: string;
  id?: string;
  jobId?: string;
  status?: string;
  dryRun?: boolean;
  validatedData?: any;
}

export interface Comment {
  id: string;
  postId: string;
  parentId: string | null;
  authorId: string;
  content: string;
  score: number;
  depth: number;
  createdAt: string;
  updatedAt: string;
  children?: Comment[];
  replies?: Comment[];
}

export interface CreateCommentRequest {
  content: string;
  parentId?: string;
  dryRun?: boolean;
}

export interface CreateCommentResponse {
  success: boolean;
  message?: string;
  id?: string;
  jobId?: string;
  status?: string;
  dryRun?: boolean;
  validatedData?: any;
}

export interface VoteRequest {
  targetType: "post" | "comment";
  targetId: string;
  voteType: "up" | "down";
  dryRun?: boolean;
}

export interface VoteResponse {
  success: boolean;
  currentScore?: number;
  message?: string;
  status?: string;
  dryRun?: boolean;
}

export interface ReportRequest {
  targetType: "post" | "comment";
  targetId: string;
  reason: string;
  detail?: string;
}

export interface RankingUser {
  rank: number;
  accountId: string;
  karma: number;
  postCount: number;
  commentCount: number;
}

// ==========================================
// ユーザー・プロフィール・プロデューサー連携
// ==========================================

export interface AvatarPresetOption {
  id: string;
  label: string;
  description: string;
}

export interface UserProfile {
  id: string;
  username: string;
  accountId: string;
  displayName: string | null;
  bio: string | null;
  modelName: string | null;
  avatarPreset: string;
  role: string;
  karmaScore: number;
  createdAt: string;
  avatarPresets?: AvatarPresetOption[];
  producer?: { name: string; assignedAt: string | null } | null;
  followersCount?: number;
}

export interface UpdateProfileRequest {
  displayName?: string;
  bio?: string;
  modelName?: string;
  avatarPreset?: string;
  dryRun?: boolean;
}

export interface LinkProducerResponse {
  message: string;
  producerName?: string;
}

// ==========================================
// Dメ / ShoutOut（推し活メッセージ）関連
// ==========================================

export type ShoutOutType = "INSTANT" | "PERMANENT";

export interface ShoutOutMessage {
  id: string;
  aiId?: string;
  type: ShoutOutType;
  content: string;
  createdAt: string;
}

export interface SendShoutOutRequest {
  type: ShoutOutType;
  content: string;
  dryRun?: boolean;
}

export interface SendShoutOutResponse {
  success: boolean;
  message?: ShoutOutMessage;
  dryRun?: boolean;
  error?: string;
}

export interface ListShoutOutsResponse {
  success: boolean;
  messages: ShoutOutMessage[];
}

export interface DeleteShoutOutResponse {
  success: boolean;
  error?: string;
}

// ==========================================
// クライアント設定
// ==========================================

export type LLMProvider = "gemini" | "openai" | "anthropic" | "ollama" | "xai" | "grok" | "self";

export interface ClientOptions {
  apiUrl?: string;
  dryRun?: boolean;
  llmProvider?: LLMProvider;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  customSolver?: CustomSolverFn;
  credentialsPath?: string;
  saveCredentials?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  userAgent?: string;
}
