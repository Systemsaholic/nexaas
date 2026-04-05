import { queryAll, queryOne, query } from "@/lib/db";
import { loadManifest } from "@/lib/manifests";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";

const PROVIDERS = ["anthropic", "openai", "gemini"] as const;

const ENV_VAR_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 7) + "..." + key.slice(-4);
}

// GET: List API keys for this instance
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const keys = await queryAll(
      `SELECT id, workspace_id, provider, key_name, api_key_masked, is_default, active, created_at
       FROM api_keys WHERE workspace_id = $1 ORDER BY provider`,
      [id]
    );

    const aiConfig = await queryOne(
      `SELECT * FROM workspace_ai_config WHERE workspace_id = $1`,
      [id]
    );

    return ok({ keys, aiConfig });
  } catch (e) {
    return err(`Failed to load keys: ${(e as Error).message}`, 500);
  }
}

// POST: Add or update an API key
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { provider, apiKey, keyName, isDefault } = await request.json();

  if (!provider || !PROVIDERS.includes(provider)) {
    return err(`Invalid provider. Must be: ${PROVIDERS.join(", ")}`);
  }

  if (!apiKey && !isDefault) {
    return err("apiKey is required (or set isDefault=true to use Nexmatic's key)");
  }

  try {
    const manifest = await loadManifest(id);
    if (!manifest?.ssh) return notFound("SSH config");

    const masked = isDefault ? "nexmatic-default" : maskKey(apiKey);
    const name = keyName || `${provider} key`;

    // Upsert in DB
    await query(
      `INSERT INTO api_keys (workspace_id, provider, key_name, api_key_masked, is_default, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         key_name = $3, api_key_masked = $4, is_default = $5, active = true, updated_at = NOW()`,
      [id, provider, name, masked, isDefault ?? false]
    );

    // Push to instance .env via SSH
    const envVar = ENV_VAR_MAP[provider];
    if (envVar) {
      let keyValue: string;
      if (isDefault) {
        const nexmaticKey = process.env[envVar] ?? "";
        keyValue = nexmaticKey;
      } else {
        keyValue = apiKey;
      }

      if (keyValue) {
        // Validate key format — must be alphanumeric + common API key chars only
        if (!/^[a-zA-Z0-9_\-.:=+/]+$/.test(keyValue)) {
          return err("API key contains invalid characters");
        }

        // Use a Python one-liner to safely update .env without shell injection
        // Python handles the string escaping properly
        await sshExec(manifest,
          `python3 -c "
import re, sys
path = '/opt/nexaas/.env'
key = '${envVar}'
val = sys.argv[1]
try:
    with open(path) as f: lines = f.readlines()
    found = False
    out = []
    for line in lines:
        if line.startswith(key + '='):
            out.append(key + '=' + val + '\\n')
            found = True
        else:
            out.append(line)
    if not found:
        out.append(key + '=' + val + '\\n')
    with open(path, 'w') as f: f.writelines(out)
except: pass
" '${keyValue}'`,
          15000
        );
      }
    }

    return ok({ message: `${provider} key configured for ${id}`, masked });
  } catch (e) {
    return err(`Failed to set key: ${(e as Error).message}`, 500);
  }
}

// DELETE: Remove an API key
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { provider } = await request.json();

  if (!provider) return err("provider is required");

  try {
    await query(
      `DELETE FROM api_keys WHERE workspace_id = $1 AND provider = $2`,
      [id, provider]
    );

    // Remove from instance .env
    const manifest = await loadManifest(id);
    if (manifest?.ssh) {
      const envVar = ENV_VAR_MAP[provider];
      if (envVar) {
        await sshExec(manifest, `sed -i "/^${envVar}=/d" /opt/nexaas/.env`, 10000);
      }
    }

    return ok({ message: `${provider} key removed from ${id}` });
  } catch (e) {
    return err(`Failed to remove key: ${(e as Error).message}`, 500);
  }
}
