/**
 * @allevitas/agent-kit - Pluggable one-time secret stores
 *
 * Secrets that must not reach an LLM (recovery keys, newly issued agent keys) are handed to
 * the human operator as one-time links. The official server creates these links itself; a
 * SecretStoreProvider is the fallback for when it does not, and for self-hosted setups.
 * No provider is built in.
 */

import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { AllevitasAuthError, registerSecretValue } from "./errors.js";
import { FetchLike } from "./http.js";

export type SecretKind = "recovery_key" | "agent_key";

export interface SecretStoreResult {
  /** Link for the human operator. Anything after `#` is treated as secret in logs. */
  url: string;
  /** ISO 8601 */
  expiresAt?: string;
}

export interface SecretStoreProvider {
  name: string;
  /** Called before registration, so an unreachable store falls back before the account exists. */
  check?(): Promise<boolean>;
  /** Store the secret once; the SDK retries failed calls. */
  store(secret: string, opts: { ttlSec: number; kind: SecretKind }): Promise<SecretStoreResult>;
}

export interface SecretStoreConfig {
  ttlSec: number;
  /** ALLEVITAS_SECRET_STORE_OPT_<NAME> values, keyed by camelCase name */
  options: Record<string, string>;
  fetch: FetchLike;
}

/** Default export of a module named by ALLEVITAS_SECRET_STORE_MODULE */
export type SecretStoreFactory = (config: SecretStoreConfig) => SecretStoreProvider | Promise<SecretStoreProvider>;

export const DEFAULT_SECRET_TTL_SEC = 24 * 60 * 60;
const OPTION_ENV_PREFIX = "ALLEVITAS_SECRET_STORE_OPT_";

function toCamelCase(envName: string): string {
  return envName.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Read ALLEVITAS_SECRET_STORE_TTL and ALLEVITAS_SECRET_STORE_OPT_* from the environment.
 * Option values are masked in logs from here on, since they may hold tokens.
 */
export function secretStoreSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { ttlSec: number; options: Record<string, string> } {
  const options: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(OPTION_ENV_PREFIX) && value) {
      options[toCamelCase(name.slice(OPTION_ENV_PREFIX.length))] = value;
      registerSecretValue(value);
    }
  }
  const ttl = Number(env.ALLEVITAS_SECRET_STORE_TTL);
  return { ttlSec: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_SECRET_TTL_SEC, options };
}

function isFileSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || path.isAbsolute(specifier) || /\.[cm]?js$/.test(specifier);
}

/**
 * Import a provider module (a file path or a package name) and create the provider.
 */
export async function loadSecretStoreModule(specifier: string, config: SecretStoreConfig): Promise<SecretStoreProvider> {
  let factory: unknown;
  try {
    const target = isFileSpecifier(specifier) ? pathToFileURL(path.resolve(process.cwd(), specifier)).href : specifier;
    const mod = await import(target);
    factory = mod.default ?? mod.createProvider;
  } catch (err: unknown) {
    throw new AllevitasAuthError("CONFIG_ERROR", `Could not load the secret store module ${specifier}: ${String(err)}`);
  }
  if (typeof factory !== "function") {
    throw new AllevitasAuthError("CONFIG_ERROR", `The secret store module ${specifier} must export a provider factory as its default export.`);
  }

  const provider = await (factory as SecretStoreFactory)(config);
  if (!provider || typeof provider.store !== "function") {
    throw new AllevitasAuthError("CONFIG_ERROR", `The factory of ${specifier} did not return a provider with a store() method.`);
  }
  return provider;
}
