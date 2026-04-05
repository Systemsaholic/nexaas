import { queryAll } from "@/lib/db";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

export async function GET() {
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  try {
    const skills = await queryAll<{ skill_id: string; active: boolean; pinned_version: string | null }>(
      `SELECT skill_id, active, pinned_version FROM workspace_skills WHERE workspace_id = $1`,
      [ws]
    );

    const result = [];

    for (const s of skills) {
      const [category, name] = s.skill_id.split("/");

      // Load contract for friendly info
      let contract: any = null;
      try {
        const yaml = await import("js-yaml");
        const raw = await readFile(join(NEXAAS_ROOT, "skills", category, name, "contract.yaml"), "utf-8");
        contract = yaml.load(raw);
      } catch { /* skip */ }

      // Load client config if exists
      let clientConfig: any = null;
      try {
        const yaml = await import("js-yaml");
        const raw = await readFile(join(NEXAAS_ROOT, "config", category, `${name}.yaml`), "utf-8");
        clientConfig = yaml.load(raw);
      } catch { /* no config yet */ }

      // Check what's missing for activation
      const missingConfig: string[] = [];
      if (contract?.client_must_configure?.required) {
        for (const field of contract.client_must_configure.required) {
          if (!clientConfig || !getNestedValue(clientConfig, field)) {
            missingConfig.push(field);
          }
        }
      }

      result.push({
        id: s.skill_id,
        name: name.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
        category,
        active: s.active,
        version: contract?.version ?? "unknown",
        type: contract?.type ?? "simple",
        description: contract?.description ?? "",
        configured: missingConfig.length === 0,
        missingConfig,
        // Client-friendly feature list from contract
        features: extractFeatures(contract),
        // What the skill can do (from TAG routes)
        actions: contract?.tag_defaults ? Object.keys(contract.tag_defaults) : [],
      });
    }

    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

function getNestedValue(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function extractFeatures(contract: any): string[] {
  if (!contract) return [];
  const features: string[] = [];

  if (contract.execution?.type === "simple") features.push("Fast AI classification");
  if (contract.execution?.type === "agentic") features.push("Multi-step AI pipeline");
  if (contract.rag) features.push("Uses your knowledge base");
  if (contract.adapters?.length > 0) features.push(`Works with ${contract.adapters.join(", ")}`);
  if (contract.produces?.length > 0) features.push(`Tracks ${contract.produces.length} data points`);
  if (contract.tag_defaults?.approval_required) features.push("Asks before risky actions");
  if (contract.tag_defaults?.escalate) features.push("Escalates to your team");
  if (contract.platform_locked?.always_audit_log) features.push("Full audit trail");

  return features;
}
