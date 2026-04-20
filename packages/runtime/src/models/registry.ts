/**
 * Model registry loader — reads model-registry.yaml and resolves tiers.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { load as yamlLoad } from "js-yaml";

export interface ProviderConfig {
  kind: "remote-api" | "openai-compatible";
  auth_env: string;
  client?: string;
  base_url_env?: string;
  status: "primary" | "fallback" | "experimental";
}

export interface ModelEntry {
  provider: string;
  model: string;
  context_window?: number;
  input_cost_per_m?: number;
  output_cost_per_m?: number;
  extended_thinking?: boolean;
}

export interface TierConfig {
  description: string;
  default_for_undeclared: boolean;
  primary: ModelEntry;
  fallbacks: ModelEntry[];
}

export interface ModelRegistry {
  version: string;
  providers: Record<string, ProviderConfig>;
  tiers: Record<string, TierConfig>;
  embedding?: {
    primary: {
      provider: string;
      model: string;
      dimensions: number;
      auth_env: string;
      cost_per_m: number;
    };
  };
}

let _registry: ModelRegistry | null = null;

export function loadRegistry(rootPath?: string): ModelRegistry {
  if (_registry) return _registry;

  const registryPath = rootPath
    ? join(rootPath, "capabilities", "model-registry.yaml")
    : join(process.env.NEXAAS_ROOT ?? "/opt/nexaas", "capabilities", "model-registry.yaml");

  const content = readFileSync(registryPath, "utf-8");
  _registry = yamlLoad(content) as ModelRegistry;
  return _registry;
}

export function resolveTier(
  tier: string,
  registry?: ModelRegistry,
): { primary: ModelEntry; fallbacks: ModelEntry[]; description: string } {
  const reg = registry ?? loadRegistry();
  const tierConfig = reg.tiers[tier];

  if (!tierConfig) {
    const defaultTier = Object.entries(reg.tiers).find(([, v]) => v.default_for_undeclared);
    if (!defaultTier) throw new Error(`Unknown tier '${tier}' and no default configured`);
    return {
      primary: defaultTier[1].primary,
      fallbacks: defaultTier[1].fallbacks,
      description: defaultTier[1].description,
    };
  }

  return {
    primary: tierConfig.primary,
    fallbacks: tierConfig.fallbacks,
    description: tierConfig.description,
  };
}

export function getProviderConfig(
  providerName: string,
  registry?: ModelRegistry,
): ProviderConfig {
  const reg = registry ?? loadRegistry();
  const provider = reg.providers[providerName];
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);
  return provider;
}

/**
 * Anthropic prompt-cache multipliers on base input-token rate:
 *   cache_creation: 1.25× (write premium, once per 5-min TTL)
 *   cache_read:     0.10× (deep discount on every hit)
 * Regular input tokens (cache-miss tail) bill at 1.0×.
 */
const CACHE_CREATION_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.10;

export function estimateCost(
  model: ModelEntry,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number {
  const inputM = (model.input_cost_per_m ?? 0) / 1_000_000;
  const outputM = (model.output_cost_per_m ?? 0) / 1_000_000;
  const cost = inputTokens * inputM
    + outputTokens * outputM
    + cacheCreationTokens * inputM * CACHE_CREATION_MULTIPLIER
    + cacheReadTokens * inputM * CACHE_READ_MULTIPLIER;
  return Math.round(cost * 10000) / 10000;
}
