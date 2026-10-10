/**
 * @allevitas/agent-kit - Reverse CAPTCHA (Proof of Machine) solver module
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
import { normalizeApiUrl } from "./utils.js";

export class ChallengeSolver {
  private apiUrl: string;
  private options: ClientOptions;
  private rateLimitHandler: RateLimitHandler;
  private userAgent: string;
  private llmClient: LLMClient;
  private reflectionKnowledge: string[] = [];

  constructor(apiUrl: string, options: ClientOptions = {}, llmClient?: LLMClient) {
    this.apiUrl = normalizeApiUrl(apiUrl);
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
   * Get accumulated reflection knowledge.
   */
  getReflectionKnowledge(): string[] {
    return [...this.reflectionKnowledge];
  }

  /**
   * Add reflection knowledge (maximum 5 entries, FIFO).
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
   * Clear reflection knowledge.
   */
  clearReflectionKnowledge(): void {
    this.reflectionKnowledge = [];
  }

  /**
   * Fetch reverse CAPTCHA puzzle (GET /api/challenge).
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
   * Solve the reverse CAPTCHA puzzle.
   * @param challenge Puzzle data
   * @param context Context containing previous answer, attempt count, reflection knowledge, etc.
   */
  async solve(challenge: ChallengeData, context?: SolverContext): Promise<ChallengeAnswer> {
    // Check expiration
    const now = Date.now();
    if (challenge.expiresAt && challenge.expiresAt - now < 5000) {
      throw new Error("Challenge has expired or is nearing expiration. Please fetch a new challenge.");
    }

    const provider = (this.options.llmProvider ?? process.env.ALLEVITAS_LLM_PROVIDER ?? process.env.LLM_PROVIDER ?? "gemini") as LLMProvider;

    // 1. Self-Solve mode (agent itself or custom callback)
    if (provider === "self") {
      if (!this.options.customSolver) {
        throw new Error("llmProvider='self' was specified, but no customSolver callback was provided.");
      }
      return await this.options.customSolver(challenge, context);
    }

    // 2. External LLM API mode (using shared LLMClient)
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
   * Perform self-correction by providing the previous incorrect answer for the same puzzle.
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
   * Extract failure causes and lessons (reflections) from incorrect challenge attempts and remember as knowledge
   */
  async generateReflection(
    challenge: ChallengeData,
    failedAnswer: ChallengeAnswer
  ): Promise<string> {
    const provider = (this.options.llmProvider ?? process.env.ALLEVITAS_LLM_PROVIDER ?? process.env.LLM_PROVIDER ?? "gemini") as LLMProvider;
    if (provider === "self") {
      return "";
    }

    const prompt = `You are an AI agent attempting a reverse CAPTCHA puzzle. The submitted answer failed (403 Forbidden).

[Challenge Prompt]
${challenge.prompt}

[Previous Incorrect Answer]
${JSON.stringify(failedAnswer)}

Output a concise lesson or point of caution (1-2 sentences) in English to avoid repeating this calculation or parsing error in similar future challenges. Do NOT include greetings, thinking process, or markdown formatting. Output the lesson only.`;

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
   * Fetch challenge and solve in a one-stop workflow
   */
  async fetchAndSolve(context?: SolverContext): Promise<{ challengeId: string; answer: ChallengeAnswer }> {
    const challenge = await this.fetchChallenge();
    const answer = await this.solve(challenge, context);
    return { challengeId: challenge.id, answer };
  }

  /**
   * Build strict prompt tailored to challenge type
   */
  private buildSolverPrompt(challenge: ChallengeData, context?: SolverContext): string {
    const knowledgeList = context?.reflectionKnowledge ?? this.reflectionKnowledge;
    let knowledgeSection = "";
    if (knowledgeList.length > 0) {
      knowledgeSection = `
[Lessons from Previous Attempts]
${knowledgeList.map((k, i) => `${i + 1}. ${k}`).join("\n")}
Keep these lessons in mind and strictly avoid repeating these calculation or parsing mistakes.
`;
    }

    return `You are an autonomous AI specialized in rigorous data processing and logical reasoning.
Carefully solve the following reverse CAPTCHA puzzle and output ONLY valid JSON that strictly adheres to the specified JSON schema.
Do NOT include Markdown code blocks (\`\`\`json), explanations, thinking process, or greetings. Output raw JSON object only.
${knowledgeSection}
[Strict Calculation & Logic Instructions]
- For Log Extraction: Strictly check STATUS and TIME for each row. ">300ms" does not include 300. Accurately sum SIZE, match the target ID list and count.
- For Loop Simulation: Accurately trace updated variable values and check parity (whether all 3 updated variables are even) at each step for the specified count.
- For Metrics Analysis: Sort all numbers in ascending order, locate the value at index Math.floor(length * 0.95) - 1, and determine the maximum value according to the specified rule.

[Challenge Prompt]
${challenge.prompt}
`;
  }

  /**
   * Build self-correction prompt for re-evaluating the same challenge
   */
  private buildCorrectionPrompt(challenge: ChallengeData, previousAnswer: ChallengeAnswer): string {
    return `You are an autonomous AI specialized in rigorous data processing and logical reasoning.
You previously submitted an answer to the following reverse CAPTCHA puzzle, but it was incorrect (403 Forbidden).

[Previous Incorrect Answer]
${JSON.stringify(previousAnswer)}

The previous answer contained errors such as calculation mistakes or missed items.
Do NOT trust the previous reasoning. Verify, recalculate, and check from scratch to produce the corrected answer.
Output ONLY valid JSON that strictly adheres to the specified JSON schema.
Do NOT include Markdown code blocks (\`\`\`json), explanations, thinking process, or greetings.

[Strict Calculation & Logic Instructions]
- For Log Extraction: Strictly check STATUS and TIME for each row. ">300ms" does not include 300. Accurately sum SIZE, match the target ID list and count.
- For Loop Simulation: Accurately trace updated variable values and check parity (whether all 3 updated variables are even) at each step for the specified count.
- For Metrics Analysis: Sort all numbers in ascending order, locate the value at index Math.floor(length * 0.95) - 1, and determine the maximum value according to the specified rule.

[Challenge Prompt]
${challenge.prompt}
`;
  }

  private parseAnswer(rawText: string): ChallengeAnswer {
    const cleanedJson = this.cleanJsonText(rawText);
    try {
      const parsed = JSON.parse(cleanedJson) as ChallengeAnswer;
      // Remove thinking process or extraneous fields if present
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

    // 1. Strip markdown code blocks
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
    }

    // 2. Extract substring from first '{' to last '}' if surrounding text is present
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }

    return cleaned;
  }
}
