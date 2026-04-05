import { loadManifest } from "@/lib/manifests";
import { ensureDnsRecord, findDnsRecord, deleteDnsRecord } from "@/lib/ovh-dns";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";

const DOMAIN = process.env.OVH_DNS_DOMAIN ?? "nexmatic.ca";

// GET: Check current domain status for this instance
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const manifest = await loadManifest(id);

    // Check if there's a domain configured in the manifest
    const subdomain = (manifest as any).domain?.subdomain;
    if (!subdomain) {
      return ok({ configured: false, domain: null, subdomain: null });
    }

    const record = await findDnsRecord(subdomain);
    return ok({
      configured: true,
      subdomain,
      domain: `${subdomain}.${DOMAIN}`,
      dnsRecord: record,
      ip: manifest.network.publicIp,
      sslReady: true, // Caddy handles auto-SSL
    });
  } catch (e) {
    return err(`Failed to check domain: ${(e as Error).message}`, 500);
  }
}

// POST: Set up or update subdomain for this instance
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { subdomain } = await request.json();

  if (!subdomain) return err("subdomain is required");
  if (!/^[a-z0-9-]+$/.test(subdomain)) return err("subdomain must be lowercase alphanumeric with hyphens only");

  try {
    const manifest = await loadManifest(id);
    const publicIp = manifest.network.publicIp;

    if (!publicIp) return err("Instance has no public IP");

    // Create/update DNS record
    const result = await ensureDnsRecord(subdomain, publicIp);
    const fullDomain = `${subdomain}.${DOMAIN}`;

    // Install Caddy on the instance if not present, configure reverse proxy
    if (manifest.ssh) {
      await sshExec(manifest, [
        // Install Caddy if not present
        "command -v caddy >/dev/null 2>&1 || (sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl 2>/dev/null && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null && sudo apt-get update 2>/dev/null && sudo apt-get install -y caddy 2>/dev/null)",
        // Write Caddyfile
        `sudo tee /etc/caddy/Caddyfile > /dev/null << 'CADDYEOF'
${fullDomain} {
    reverse_proxy localhost:3001
}
CADDYEOF`,
        // Reload Caddy
        "sudo systemctl enable caddy 2>/dev/null && sudo systemctl restart caddy",
      ].join(" && "), 120000);
    }

    // Update workspace manifest with domain info
    const { readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
    const manifestPath = join(nexaasRoot, "workspaces", `${id}.workspace.json`);
    const raw = await readFile(manifestPath, "utf-8");
    const manifestData = JSON.parse(raw);
    manifestData.domain = { subdomain, fullDomain, configuredAt: new Date().toISOString() };
    await writeFile(manifestPath, JSON.stringify(manifestData, null, 2));

    return ok({
      subdomain,
      domain: fullDomain,
      dnsAction: result.action,
      ip: publicIp,
      message: `Domain ${fullDomain} configured. SSL will be provisioned automatically by Caddy.`,
    });
  } catch (e) {
    return err(`Failed to configure domain: ${(e as Error).message}`, 500);
  }
}

// DELETE: Remove subdomain
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const manifest = await loadManifest(id);
    const subdomain = (manifest as any).domain?.subdomain;

    if (!subdomain) return ok({ message: "No domain configured" });

    // Remove DNS record
    const record = await findDnsRecord(subdomain);
    if (record) {
      await deleteDnsRecord(record.id);
    }

    // Remove from manifest
    const { readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
    const manifestPath = join(nexaasRoot, "workspaces", `${id}.workspace.json`);
    const raw = await readFile(manifestPath, "utf-8");
    const manifestData = JSON.parse(raw);
    delete manifestData.domain;
    await writeFile(manifestPath, JSON.stringify(manifestData, null, 2));

    return ok({ message: `Domain ${subdomain}.${DOMAIN} removed` });
  } catch (e) {
    return err(`Failed to remove domain: ${(e as Error).message}`, 500);
  }
}
