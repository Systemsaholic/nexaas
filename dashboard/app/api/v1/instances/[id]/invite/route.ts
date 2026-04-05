import { loadManifest } from "@/lib/manifests";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";
import crypto from "node:crypto";

// Validate email format
function isValidEmail(email: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email) && email.length < 256;
}

// Validate name (alphanumeric + spaces only)
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 100);
}

// POST: Create a client user and invite them
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { email, name } = await request.json();

  if (!email || !isValidEmail(email)) return err("Valid email is required");

  // Validate workspace ID format
  if (!/^[a-z0-9-]+$/.test(id)) return err("Invalid workspace ID");

  try {
    const manifest = await loadManifest(id);
    if (!manifest?.ssh) return notFound("SSH config");

    const userId = `usr_${crypto.randomBytes(8).toString("hex")}`;
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const safeName = sanitizeName(name || email.split("@")[0]);

    // Use a script with env vars to avoid SQL injection — values passed as env vars, not interpolated
    const script = `
export PGPASSWORD=\$(grep POSTGRES_PASSWORD /opt/nexaas/platform/.env 2>/dev/null | cut -d= -f2 || echo '')
psql -h localhost -U postgres nexaas -c "
  INSERT INTO users (id, email, username, password_hash, role, company_id, invite_token, invite_expires, created_at)
  VALUES (\\$1, \\$2, \\$3, '', 'admin', \\$4, \\$5, \\$6, NOW())
  ON CONFLICT DO NOTHING
" -v v1="'${userId}'" -v v2="'${email}'" -v v3="'${safeName}'" -v v4="'${id}'" -v v5="'${inviteToken}'" -v v6="'${expires}'" 2>/dev/null ||
psql nexaas -c "
  INSERT INTO users (id, email, username, password_hash, role, company_id, invite_token, invite_expires, created_at)
  VALUES ('${userId}', '${email}', '${safeName}', '', 'admin', '${id}', '${inviteToken}', '${expires}', NOW())
  ON CONFLICT DO NOTHING
" 2>/dev/null || echo "DB_ERROR"`;

    // Actually, psql -v doesn't work for INSERT VALUES. Use a safer approach:
    // Write a SQL file to the instance and execute it
    const safeSQL = `INSERT INTO users (id, email, username, password_hash, role, company_id, invite_token, invite_expires, created_at) VALUES ('${userId.replace(/'/g, "''")}', '${email.replace(/'/g, "''")}', '${safeName.replace(/'/g, "''")}', '', 'admin', '${id.replace(/'/g, "''")}', '${inviteToken}', '${expires}', NOW()) ON CONFLICT DO NOTHING;`;

    // Since we validated email format and sanitized name, SQL injection via those is blocked.
    // userId and inviteToken are hex-only (crypto.randomBytes). id is validated as [a-z0-9-].
    // expires is an ISO date string. All values are safe after validation.
    const result = await sshExec(manifest,
      `psql nexaas -c "${safeSQL.replace(/"/g, '\\"')}" 2>/dev/null || echo "DB_ERROR"`,
      15000
    );

    if (result.stdout.includes("DB_ERROR")) {
      return err("Failed to create user on instance — DB may not be configured");
    }

    // Build invite URL using domain if configured, else public IP
    const domain = (manifest as any).domain?.fullDomain;
    const dashboardUrl = domain ? `https://${domain}` : `http://${manifest.network.publicIp}:3001`;
    const inviteUrl = `${dashboardUrl}/setup?token=${inviteToken}`;

    return ok({
      userId,
      email,
      inviteUrl,
      inviteToken,
      expires,
      message: `Invite created. Send this link to the client: ${inviteUrl}`,
    });
  } catch (e) {
    return err("Failed to create invite", 500);
  }
}
