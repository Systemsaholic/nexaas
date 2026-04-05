import { loadManifest } from "@/lib/manifests";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";
import crypto from "node:crypto";

// POST: Create a client user and invite them
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { email, name } = await request.json();

  if (!email) return err("email is required");

  try {
    const manifest = await loadManifest(id);
    if (!manifest?.ssh) return notFound("SSH config");

    const userId = `usr_${crypto.randomBytes(8).toString("hex")}`;
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    // Create user on the instance's local DB via SSH
    const sql = `INSERT INTO users (id, email, username, password_hash, role, company_id, invite_token, invite_expires, created_at)
      VALUES ('${userId}', '${email}', '${name || email.split("@")[0]}', '', 'admin', '${id}', '${inviteToken}', '${expires}', NOW())
      ON CONFLICT (email) DO UPDATE SET invite_token = '${inviteToken}', invite_expires = '${expires}'`;

    const result = await sshExec(manifest,
      `PGPASSWORD=$(grep POSTGRES_PASSWORD /opt/nexaas/platform/.env 2>/dev/null | cut -d= -f2 || echo '') psql -h localhost -U postgres nexaas -c "${sql}" 2>/dev/null || psql nexaas -c "${sql}" 2>/dev/null || echo "DB_ERROR"`,
      15000
    );

    if (result.stdout.includes("DB_ERROR")) {
      return err("Failed to create user on instance — DB may not be configured");
    }

    // Build the invite URL
    const dashboardUrl = `http://${manifest.network.publicIp}:3001`;
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
    return err(`Failed to create invite: ${(e as Error).message}`, 500);
  }
}
