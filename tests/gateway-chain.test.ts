/**
 * Unit tests for resolveAgenticChain (#255) — the registry→model-chain
 * resolution behind ModelGateway.executeAgentic. Every live agentic caller
 * (ai-skill, PA, subagent) selects models through this;
 * a regression here changes what model every skill in the fleet runs on.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgenticChain } from "../packages/runtime/src/models/gateway.js";
import { loadRegistry, type ModelRegistry } from "../packages/runtime/src/models/registry.js";
import { probeModel } from "../packages/runtime/src/models/probe.js";

const REPO_ROOT = join(__dirname, "..");

const fakeRegistry = {
  tiers: {
    mixed: {
      description: "anthropic primary with mixed fallbacks",
      primary: { provider: "anthropic", model: "claude-a", input_cost_per_m: 3, output_cost_per_m: 15 },
      fallbacks: [
        { provider: "openai", model: "gpt-x", input_cost_per_m: 2, output_cost_per_m: 10 },
        { provider: "anthropic", model: "claude-b", input_cost_per_m: 15, output_cost_per_m: 75 },
        { provider: "openrouter", model: "gemini-y" },
      ],
    },
    unpriced: {
      description: "entry without cost fields",
      default_for_undeclared: true,
      primary: { provider: "anthropic", model: "claude-c" },
      fallbacks: [],
    },
  },
  providers: { anthropic: { auth_env: "ANTHROPIC_API_KEY" } },
} as unknown as ModelRegistry;

describe("resolveAgenticChain", () => {
  it("keeps only anthropic entries, preserving order", () => {
    const chain = resolveAgenticChain("mixed", fakeRegistry);
    expect(chain.map((c) => c.model)).toEqual(["claude-a", "claude-b"]);
  });

  it("maps registry costs to loop pricing", () => {
    const chain = resolveAgenticChain("mixed", fakeRegistry);
    expect(chain[0]!.pricing).toEqual({ inputCostPerM: 3, outputCostPerM: 15 });
    expect(chain[1]!.pricing).toEqual({ inputCostPerM: 15, outputCostPerM: 75 });
  });

  it("leaves pricing undefined when the registry entry has no costs", () => {
    const chain = resolveAgenticChain("unpriced", fakeRegistry);
    expect(chain[0]!.model).toBe("claude-c");
    expect(chain[0]!.pricing).toBeUndefined();
  });

  it("falls through to default_for_undeclared for unknown tiers", () => {
    const chain = resolveAgenticChain("no-such-tier", fakeRegistry);
    expect(chain[0]!.model).toBe("claude-c");
  });
});

describe("real registry — agentic-path invariants (#255)", () => {
  const real = loadRegistry(REPO_ROOT);

  it("every tier resolves to a non-empty anthropic chain", () => {
    for (const tier of Object.keys(real.tiers)) {
      const chain = resolveAgenticChain(tier, real);
      expect(chain.length, `tier '${tier}' has no anthropic-capable model`).toBeGreaterThan(0);
    }
  });

  it("every tier's PRIMARY is anthropic (agentic loop speaks its wire format)", () => {
    for (const [name, tier] of Object.entries(real.tiers)) {
      expect(tier.primary.provider, `tier '${name}' primary is not anthropic`).toBe("anthropic");
    }
  });

  it("every anthropic chain entry carries pricing (spend caps depend on it)", () => {
    for (const tier of Object.keys(real.tiers)) {
      for (const entry of resolveAgenticChain(tier, real)) {
        expect(entry.pricing, `tier '${tier}' model '${entry.model}' has no pricing`).toBeDefined();
      }
    }
  });
});

describe("probeModel", () => {
  it("resolves the cheap tier's primary from the registry", () => {
    const real = loadRegistry(REPO_ROOT);
    expect(probeModel()).toBe(real.tiers.cheap!.primary.model);
  });
});
