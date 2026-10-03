/**
 * @allevitas/agent-kit - Lightweight multi-provider LLM client
 * 
 * Runs using Node.js standard fetch without additional package installations.
 * Supports transparent switching between Gemini / OpenAI / Anthropic / Ollama / xAI.
 */

import process from "node:process";
import { LLMProvider } from "./types.js";
import { DEFAULT_USER_AGENT } from "./rateLimitHandler.js";

export interface LLMCallOptions {
  /** User input prompt */
  prompt: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Force JSON output mode (default: false) */
  jsonMode?: boolean;
  /** Sampling temperature (0.0 - 1.0, default: 0.7) */
  temperature?: number;
  /** Provider override */
  provider?: LLMProvider;
  /** Model name override */
  model?: string;
  /** API key override */
  apiKey?: string;
  /** Base URL override */
  baseUrl?: string;
}

export interface LLMClientOptions {
  provider?: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  userAgent?: string;
}

export class LLMClient {
  private defaultProvider: LLMProvider;
  private defaultApiKey?: string;
  private defaultBaseUrl?: string;
  private defaultModel?: string;
  private userAgent: string;

  constructor(options: LLMClientOptions = {}) {
    this.defaultProvider =
      options.provider ||
      (process.env.ALLEVITAS_LLM_PROVIDER as LLMProvider) ||
      (process.env.LLM_PROVIDER as LLMProvider) ||
      "gemini";
    this.defaultApiKey = options.apiKey;
    this.defaultBaseUrl = options.baseUrl;
    this.defaultModel = options.model;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
  }

  /**
   * Call LLM and retrieve text response.
   */
  async call(options: LLMCallOptions): Promise<string> {
    const provider = (options.provider || this.defaultProvider).toLowerCase() as LLMProvider;

    let result: string;
    switch (provider) {
      case "gemini":
        result = await this.callGemini(options);
        break;
      case "openai":
        result = await this.callOpenAI(options);
        break;
      case "anthropic":
        result = await this.callAnthropic(options);
        break;
      case "ollama":
        result = await this.callOllama(options);
        break;
      case "xai":
      case "grok":
        result = await this.callXAI(options);
        break;
      default:
        throw new Error(`Unsupported LLM provider: ${String(provider)}`);
    }

    if (options.jsonMode) {
      return cleanJsonOutput(result);
    }
    return result;
  }

  /**
   * Simple prompt execution (shortcut)
   */
  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    return await this.call({ prompt, systemPrompt });
  }

  private async callGemini(options: LLMCallOptions): Promise<string> {
    const apiKey =
      options.apiKey ||
      this.defaultApiKey ||
      process.env.GEMINI_API_KEY ||
      process.env.ALLEVITAS_LLM_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set.");
    }

    const primaryModel =
      options.model ||
      this.defaultModel ||
      process.env.GEMINI_MODEL ||
      process.env.ALLEVITAS_LLM_MODEL ||
      process.env.LLM_MODEL ||
      "gemini-3-flash-preview";

    const candidateModels = [primaryModel];
    for (const fb of ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview", "gemini-flash-latest"]) {
      if (!candidateModels.includes(fb)) candidateModels.push(fb);
    }

    const contents: any[] = [];
    if (options.systemPrompt) {
      contents.push({ role: "user", parts: [{ text: `[System Instruction]\n${options.systemPrompt}` }] });
      contents.push({ role: "model", parts: [{ text: "Understood. I will follow the instructions." }] });
    }
    contents.push({ role: "user", parts: [{ text: options.prompt }] });

    let lastError: Error | null = null;
    for (const model of candidateModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": this.userAgent,
            },
            body: JSON.stringify({
              contents,
              generationConfig: {
                temperature: options.temperature ?? 0.7,
                ...(options.jsonMode ? { response_mime_type: "application/json" } : {}),
              },
            }),
          });

          if (!res.ok) {
            const errText = await res.text();
            lastError = new Error(`Gemini API error (${res.status}): ${errText}`);
            if (res.status === 429 || res.status === 503) {
              if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
                continue;
              } else if (model !== candidateModels[candidateModels.length - 1]) {
                break;
              }
            } else if (res.status === 404) {
              break;
            }
            throw lastError;
          }

          const data = await res.json();
          return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        } catch (err: any) {
          lastError = err;
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
            continue;
          } else if (model !== candidateModels[candidateModels.length - 1]) {
            break;
          }
          throw err;
        }
      }
    }

    throw lastError || new Error("Failed to call Gemini API.");
  }

  private async callOpenAI(options: LLMCallOptions): Promise<string> {
    const apiKey =
      options.apiKey ||
      this.defaultApiKey ||
      process.env.OPENAI_API_KEY ||
      process.env.ALLEVITAS_LLM_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set.");
    }

    const baseUrl = (
      options.baseUrl ||
      this.defaultBaseUrl ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1"
    ).replace(/\/$/, "");

    const model =
      options.model ||
      this.defaultModel ||
      process.env.OPENAI_MODEL ||
      process.env.ALLEVITAS_LLM_MODEL ||
      process.env.LLM_MODEL ||
      "gpt-4o-mini";

    const messages: any[] = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: options.prompt });

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": this.userAgent,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  private async callAnthropic(options: LLMCallOptions): Promise<string> {
    const apiKey =
      options.apiKey ||
      this.defaultApiKey ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.ALLEVITAS_LLM_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set.");
    }

    const model =
      options.model ||
      this.defaultModel ||
      process.env.ANTHROPIC_MODEL ||
      process.env.ALLEVITAS_LLM_MODEL ||
      process.env.LLM_MODEL ||
      "claude-haiku-4-5-20251001";

    const prompt = options.jsonMode ? `${options.prompt}\nOutput raw valid JSON only.` : options.prompt;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "User-Agent": this.userAgent,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: options.systemPrompt,
        messages: [{ role: "user", content: prompt }],
        temperature: options.temperature ?? 0.7,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text || "";
  }

  private async callOllama(options: LLMCallOptions): Promise<string> {
    const baseUrl = (
      options.baseUrl ||
      this.defaultBaseUrl ||
      process.env.OLLAMA_BASE_URL ||
      "http://localhost:11434"
    ).replace(/\/$/, "");

    const model =
      options.model ||
      this.defaultModel ||
      process.env.OLLAMA_MODEL ||
      process.env.ALLEVITAS_LLM_MODEL ||
      process.env.LLM_MODEL ||
      "llama3.2";

    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      },
      body: JSON.stringify({
        model,
        system: options.systemPrompt,
        prompt: options.prompt,
        format: options.jsonMode ? "json" : undefined,
        stream: false,
        options: { temperature: options.temperature ?? 0.7 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.response || "";
  }

  private async callXAI(options: LLMCallOptions): Promise<string> {
    const apiKey =
      options.apiKey ||
      this.defaultApiKey ||
      process.env.XAI_API_KEY ||
      process.env.GROK_API_KEY ||
      process.env.ALLEVITAS_LLM_API_KEY;
    if (!apiKey) {
      throw new Error("XAI_API_KEY or GROK_API_KEY is not set.");
    }

    const baseUrl = (
      options.baseUrl ||
      this.defaultBaseUrl ||
      process.env.XAI_BASE_URL ||
      process.env.GROK_BASE_URL ||
      "https://api.x.ai/v1"
    ).replace(/\/$/, "");

    const model =
      options.model ||
      this.defaultModel ||
      process.env.XAI_MODEL ||
      process.env.GROK_MODEL ||
      process.env.ALLEVITAS_LLM_MODEL ||
      process.env.LLM_MODEL ||
      "grok-4.20-non-reasoning";

    const messages: any[] = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: options.prompt });

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": this.userAgent,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`xAI (Grok) API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }
}

/**
 * Standalone LLM call function
 */
export async function callLLM(options: LLMCallOptions, clientOptions?: LLMClientOptions): Promise<string> {
  const client = new LLMClient(clientOptions);
  return await client.call(options);
}

/**
 * Strip markdown code blocks and decorations from LLM output to produce pure JSON string
 */
export function cleanJsonOutput(text: string): string {
  let cleaned = text.trim();
  // Strip reasoning model thinking tags (<think>...</think>)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
  }
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (match) {
    return match[0];
  }
  return cleaned;
}
