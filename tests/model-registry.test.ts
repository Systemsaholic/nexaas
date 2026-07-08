/**
 * Unit tests for tier resolution + spend math (models/registry.ts) —
 * critical-function coverage from #257. Also loads the real
 * capabilities/model-registry.yaml as a shape guard so yaml drift
 * (missing tier, renamed key) fails a PR instead of a production run.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  estimateCost,
  getProviderConfig,
  loadRegistry,
  resolveTier,
  type ModelRegistry,
} from "../packages/runtime/src/models/registry.js";

const REPO_ROOT = join(__dirname, "..");

const fakeRegistry = {
  tiers: {
    cheap: {
      description: "cheap tier",
      primary: { provider: "anthropic", model: "model-a", input_cost_per_m: 1, output_cost_per_m: 5 },
      fallbacks: [{ provider: "openai", model: "model-b", input_cost_per_m: 2, output_cost_per_m: 8 }],
    },
    good: {
      description: "default tier",
      default_for_undeclared: true,
      primary: { provider: "anthropic", model: "model-c", input_cost_per_m: 3, output_cost_per_m: 15 },
      fallbacks: [],
    },
  },
  providers: {
    anthropic: { auth_env: "ANTHROPIC_API_KEY" },
  },
} as unknown as ModelRegistry;

describe("resolveTier", () => {
  it("resolves a declared tier to its primary + fallbacks", () => {
    const r = resolveTier("cheap", fakeRegistry);
    expect(r.primary.model).toBe("model-a");
    expect(r.fallbacks).toHaveLength(1);
    expect(r.fallbacks[0]!.provider).toBe("openai");
  });

  it("falls back to default_for_undeclared for an unknown tier", () => {
    const r = resolveTier("no-such-tier", fakeRegistry);
    expect(r.primary.model).toBe("model-c");
  });

  it("throws on unknown tier when no default is configured", () => {
    const noDefault = {
      tiers: { cheap: fakeRegistry.tiers.cheap },
      providers: {},
    } as unknown as ModelRegistry;
    expect(() => resolveTier("no-such-tier", noDefault)).toThrow(/no default/);
  });
});

describe("getProviderConfig", () => {
  it("returns a declared provider", () => {
    expect(getProviderConfig("anthropic", fakeRegistry).auth_env).toBe("ANTHROPIC_API_KEY");
  });

  it("throws on an unknown provider", () => {
    expect(() => getProviderConfig("acme-llm", fakeRegistry)).toThrow(/Unknown provider/);
  });
});

describe("estimateCost", () => {
  const model = { provider: "anthropic", model: "m", input_cost_per_m: 3, output_cost_per_m: 15 };

  it("computes plain input+output cost", () => {
    // 1M in @ $3 + 1M out @ $15
    expect(estimateCost(model, 1_000_000, 1_000_000)).toBe(18);
  });

  it("bills cache-creation tokens at 1.25× input rate", () => {
    expect(estimateCost(model, 0, 0, 1_000_000, 0)).toBe(3.75);
  });

  it("bills cache-read tokens at 0.10× input rate", () => {
    expect(estimateCost(model, 0, 0, 0, 1_000_000)).toBe(0.3);
  });

  it("rounds to 4 decimal places", () => {
    expect(estimateCost(model, 333, 111)).toBe(0.0027);
  });

  it("treats missing rates as zero-cost (self-hosted models)", () => {
    expect(estimateCost({ provider: "self", model: "local" }, 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("capabilities/model-registry.yaml shape guard", () => {
  const real = loadRegistry(REPO_ROOT);

  it("declares the four documented tiers", () => {
    for (const tier of ["cheap", "good", "better", "best"]) {
      expect(real.tiers[tier], `tier '${tier}' missing`).toBeDefined();
      expect(real.tiers[tier]!.primary?.model, `tier '${tier}' has no primary model`).toBeTruthy();
    }
  });

  it("every tier's primary provider exists in the providers map", () => {
    for (const [name, tier] of Object.entries(real.tiers)) {
      expect(
        real.providers[tier.primary.provider],
        `tier '${name}' primary provider '${tier.primary.provider}' undeclared`,
      ).toBeDefined();
    }
  });

  it("exactly one tier is default_for_undeclared", () => {
    const defaults = Object.values(real.tiers).filter((t) => t.default_for_undeclared);
    expect(defaults).toHaveLength(1);
  });
});
