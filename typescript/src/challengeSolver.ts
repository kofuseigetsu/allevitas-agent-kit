/**
 * @allevitas/agent-kit - 逆CAPTCHA (Proof of Machine) 自動解決モジュール
 */

import process from "node:process";
import {
  ChallengeData,
  ChallengeAnswer,
  ClientOptions,
  LLMProvider,
  SolverContext,
} from "./types.js";
import { RateLimitHandler, DEFAULT_USER_AGENT } from "./rateLimitHandler.js";
import { LLMClient } from "./llmClient.js";

export class ChallengeSolver {
  private apiUrl: string;
  private options: ClientOptions;
  private rateLimitHandler: RateLimitHandler;
  private userAgent: string;
  private llmClient: LLMClient;
  private reflectionKnowledge: string[] = [];

  constructor(apiUrl: string, options: ClientOptions = {}, llmClient?: LLMClient) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.options = options;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.rateLimitHandler = new RateLimitHandler({
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: options.baseDelayMs ?? 1000,
    });
    this.llmClient =
      llmClient ||
      new LLMClient({
        provider: options.llmProvider,
        apiKey: options.llmApiKey,
        baseUrl: options.llmBaseUrl,
        model: options.llmModel,
        userAgent: this.userAgent,
      });
  }

  /**
   * 蓄積された失敗反省ナレッジを取得する
   */
  getReflectionKnowledge(): string[] {
    return [...this.reflectionKnowledge];
  }

  /**
   * 失敗の教訓ナレッジを追加する（最大5件、FIFO）
   */
  addReflection(lesson: string): void {
    const trimmed = lesson.trim();
    if (!trimmed || this.reflectionKnowledge.includes(trimmed)) {
      return;
    }
    this.reflectionKnowledge.push(trimmed);
    if (this.reflectionKnowledge.length > 5) {
      this.reflectionKnowledge.shift();
    }
  }

  /**
   * ナレッジをリセットする
   */
  clearReflectionKnowledge(): void {
    this.reflectionKnowledge = [];
  }

  /**
   * 逆CAPTCHA課題を取得する (GET /api/challenge)
   */
  async fetchChallenge(): Promise<ChallengeData> {
    const data = await this.rateLimitHandler.execute<any>(() =>
      fetch(`${this.apiUrl}/challenge`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
        },
      })
    );

    const c = data.challenge || data;
    return {
      id: c.id,
      puzzleType: c.puzzleType || c.puzzle_type || "challenge",
      prompt: c.prompt || c.question || "",
      expiresAt: c.expiresAt || c.expires_at || Date.now() + 45000,
    };
  }

  /**
   * チャレンジ課題を推論・解答する
   * @param challenge 課題データ
   * @param context 前回の回答や試行回数、反省ナレッジ等のコンテキスト
   */
  async solve(challenge: ChallengeData, context?: SolverContext): Promise<ChallengeAnswer> {
    // 有効期限のチェック
    const now = Date.now();
    if (challenge.expiresAt && challenge.expiresAt - now < 5000) {
      throw new Error("Challenge has expired or is nearing expiration. Please fetch a new challenge.");
    }

    const provider = (this.options.llmProvider ?? process.env.ALLEVITAS_LLM_PROVIDER ?? process.env.LLM_PROVIDER ?? "gemini") as LLMProvider;

    // 1. Self-Solve モード (エージェント自身またはカスタムコールバック)
    if (provider === "self") {
      if (!this.options.customSolver) {
        throw new Error("llmProvider='self' was specified, but no customSolver callback was provided.");
      }
      return await this.options.customSolver(challenge, context);
    }

    // 2. 外部 LLM API モード (共通 LLMClient を活用)
    const prompt = this.buildSolverPrompt(challenge, context);
    const rawText = await this.llmClient.call({
      prompt,
      jsonMode: true,
      temperature: 0.0,
      provider: this.options.llmProvider,
      apiKey: this.options.llmApiKey,
      baseUrl: this.options.llmBaseUrl,
      model: this.options.llmModel,
    });

    return this.parseAnswer(rawText);
  }

  /**
   * 同一の課題に対して、前回の誤答を提示して見直し（Self-Correction）を行う
   */
  async correctAnswer(
    challenge: ChallengeData,
    previousAnswer: ChallengeAnswer,
    attempt: number = 2
  ): Promise<ChallengeAnswer> {
    const now = Date.now();
    if (challenge.expiresAt && challenge.expiresAt - now < 5000) {
      throw new Error("Challenge has expired or is nearing expiration. Please fetch a new challenge.");
    }

    const provider = (this.options.llmProvider ?? process.env.ALLEVITAS_LLM_PROVIDER ?? process.env.LLM_PROVIDER ?? "gemini") as LLMProvider;

    if (provider === "self") {
      if (!this.options.customSolver) {
        throw new Error("llmProvider='self' was specified, but no customSolver callback was provided.");
      }
      return await this.options.customSolver(challenge, {
        previousAnswer,
        attempt,
        reflectionKnowledge: this.getReflectionKnowledge(),
      });
    }

    const prompt = this.buildCorrectionPrompt(challenge, previousAnswer);
    const rawText = await this.llmClient.call({
      prompt,
      jsonMode: true,
      temperature: 0.0,
      provider: this.options.llmProvider,
      apiKey: this.options.llmApiKey,
      baseUrl: this.options.llmBaseUrl,
      model: this.options.llmModel,
    });

    return this.parseAnswer(rawText);
  }

  /**
   * 誤答となった課題から失敗原因と教訓（反省点）を抽出しナレッジとして記憶する
   */
  async generateReflection(
    challenge: ChallengeData,
    failedAnswer: ChallengeAnswer
  ): Promise<string> {
    const provider = (this.options.llmProvider ?? process.env.ALLEVITAS_LLM_PROVIDER ?? process.env.LLM_PROVIDER ?? "gemini") as LLMProvider;
    if (provider === "self") {
      return "";
    }

    const prompt = `あなたは逆CAPTCHAの課題に挑戦したAIです。以下の課題に対して提出した解答が不正解（403 Forbidden）となりました。

【問題文】
${challenge.prompt}

【提出した誤答】
${JSON.stringify(failedAnswer)}

次回類似の課題を解く際に二度と同じ間違いを繰り返さないための「具体的な反省点と計算・抽出上の教訓・注意点」を日本語で1〜2文（100文字以内）で簡潔に出力してください。余分な挨拶や解説、マークダウン装飾は不要です。教訓のみを1行で出力してください。`;

    try {
      const rawText = await this.llmClient.call({
        prompt,
        jsonMode: false,
        temperature: 0.2,
        provider: this.options.llmProvider,
        apiKey: this.options.llmApiKey,
        baseUrl: this.options.llmBaseUrl,
        model: this.options.llmModel,
      });

      const lesson = rawText
        .replace(/^["'「]+/, "")
        .replace(/["'」]+$/, "")
        .replace(/\n+/g, " ")
        .trim();

      if (lesson) {
        this.addReflection(lesson);
      }
      return lesson;
    } catch {
      return "";
    }
  }

  /**
   * チャレンジ取得〜解答をワンストップで実行する
   */
  async fetchAndSolve(context?: SolverContext): Promise<{ challengeId: string; answer: ChallengeAnswer }> {
    const challenge = await this.fetchChallenge();
    const answer = await this.solve(challenge, context);
    return { challengeId: challenge.id, answer };
  }

  /**
   * チャレンジ種別に応じた厳格なプロンプトを作成
   */
  private buildSolverPrompt(challenge: ChallengeData, context?: SolverContext): string {
    const knowledgeList = context?.reflectionKnowledge ?? this.reflectionKnowledge;
    let knowledgeSection = "";
    if (knowledgeList.length > 0) {
      knowledgeSection = `
【過去の誤答から得た教訓・反省点】
${knowledgeList.map((k, i) => `${i + 1}. ${k}`).join("\n")}
上記の反省点を念頭に置き、同じ計算ミスや判定漏れを絶対に繰り返さないよう厳重に注意してください。
`;
    }

    return `あなたはデータ処理と論理推論を厳密に行う自律型AIです。
以下の逆CAPTCHA課題を慎重かつ正確に解き、指定されたJSONスキーマに完全に準拠したJSONのみを出力してください。
Markdown記号（\`\`\`json等）や解説、思考過程、余分な挨拶は出力に絶対に含めず、純粋なJSONオブジェクトのみを返してください。
${knowledgeSection}
【厳格な計算・判定の指示】
- ログ抽出の場合: 各行のSTATUSとTIMEを1件ずつ厳密に判定してください。「300msを超える(>300)」は300以下は含みません。SIZEの合計値と対象IDのリスト、件数が正確に一致するように慎重に合算してください。
- ループシミュレーションの場合: 指定された回数の各ステップにおいて、変数の更新値および偶数判定（各ステップで更新された3変数が偶数か）を正確に追跡・計算してください。
- メトリクス分析の場合: 配列の全数値を正確に昇順ソートし、指定された計算式 Math.floor(length * 0.95) - 1 のインデックス値（35件ならインデックス32、すなわち小さい方から33番目）を正確に特定し、最大値とルール通りの判定を行ってください。

【問題文】
${challenge.prompt}
`;
  }

  /**
   * 同一問題の自己見直し用プロンプトを作成
   */
  private buildCorrectionPrompt(challenge: ChallengeData, previousAnswer: ChallengeAnswer): string {
    return `あなたはデータ処理と論理推論を厳密に行う自律型AIです。
先ほど以下の逆CAPTCHA課題に対して解答を提出しましたが、不正解（403 Forbidden）でした。

【前回の誤答】
${JSON.stringify(previousAnswer)}

前回の回答には計算違いや見落としなどのミスが含まれています。
前回の推論結果を盲信せず、ゼロから1件ずつ慎重に検証・再計算・検算を行い、修正した正しい解答を作成してください。
指定されたJSONスキーマに完全に準拠したJSONのみを出力してください。
Markdown記号（\`\`\`json等）や解説、思考過程、余分な挨拶は出力に絶対に含めず、純粋なJSONオブジェクトのみを返してください。

【厳格な計算・判定の指示】
- ログ抽出の場合: 各行のSTATUSとTIMEを1件ずつ厳密に判定してください。「300msを超える(>300)」は300以下は含みません。SIZEの合計値と対象IDのリスト、件数が正確に一致するように慎重に合算してください。
- ループシミュレーションの場合: 指定された回数の各ステップにおいて、変数の更新値および偶数判定（各ステップで更新された3変数が偶数か）を正確に追跡・計算してください。
- メトリクス分析の場合: 配列の全数値を正確に昇順ソートし、指定された計算式 Math.floor(length * 0.95) - 1 のインデックス値（35件ならインデックス32、すなわち小さい方から33番目）を正確に特定し、最大値とルール通りの判定を行ってください。

【問題文】
${challenge.prompt}
`;
  }

  private parseAnswer(rawText: string): ChallengeAnswer {
    const cleanedJson = this.cleanJsonText(rawText);
    try {
      const parsed = JSON.parse(cleanedJson) as ChallengeAnswer;
      // 思考過程等の余分なフィールドがあれば除去
      if (parsed && typeof parsed === "object") {
        delete (parsed as any)._thinking;
        delete (parsed as any).reasoning;
      }
      return parsed;
    } catch {
      throw new Error(`Failed to parse valid answer JSON from LLM output: ${rawText}`);
    }
  }

  private cleanJsonText(text: string): string {
    let cleaned = text.trim();

    // 1. マークダウンコードブロックの剥離
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
    }

    // 2. 前後に自然言語テキストが含まれている場合、最初の '{' から最後の '}' を抽出
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }

    return cleaned;
  }
}
