import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import YAML from "js-yaml";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
const WORKSPACE = process.env.NEXAAS_WORKSPACE ?? "";

function getConfigPath(): string {
  return join(NEXAAS_ROOT, "config", "client-profile.yaml");
}

// GET: Load current behavioral contract
export async function GET() {
  try {
    const raw = await readFile(getConfigPath(), "utf-8");
    const config = YAML.load(raw) as Record<string, unknown>;
    return NextResponse.json({ ok: true, data: config });
  } catch (e) {
    // Return defaults if no config exists
    return NextResponse.json({
      ok: true,
      data: {
        workspace: WORKSPACE,
        tone: "professional, friendly",
        domain: "",
        approval_gates: {
          reply_external: "required",
          reply_known: "notify_after",
          payment: "required",
          delete: "always_manual",
        },
        hard_limits: [],
        escalation_rules: {
          financial: "",
          complaints: "",
          legal: "",
        },
        notification_prefs: {
          channel: "email",
          mode: "digest_urgent_only",
        },
      },
    });
  }
}

// PUT: Update behavioral contract
export async function PUT(request: Request) {
  try {
    const config = await request.json();

    await mkdir(join(NEXAAS_ROOT, "config"), { recursive: true });
    await writeFile(getConfigPath(), YAML.dump(config, { lineWidth: 120 }), "utf-8");

    return NextResponse.json({ ok: true, message: "Preferences saved" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
