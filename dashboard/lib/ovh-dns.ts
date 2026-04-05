/**
 * Cloudflare DNS management for nexmatic.ca subdomains.
 *
 * Uses Cloudflare API v4 to create, update, and delete A records.
 * Proxied through Cloudflare for DDoS protection + SSL.
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const CF_TOKEN = () => process.env.CLOUDFLARE_API_TOKEN ?? "";
const CF_ZONE_ID = () => process.env.CLOUDFLARE_ZONE_ID ?? "";
const DOMAIN = process.env.OVH_DNS_DOMAIN ?? "nexmatic.ca";

async function cfFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${CF_TOKEN()}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  const json = await res.json() as { success: boolean; result: T; errors: Array<{ message: string }> };
  if (!json.success) {
    throw new Error(json.errors?.[0]?.message ?? "Cloudflare API error");
  }
  return json.result;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

// List DNS records, optionally filtered by name
export async function listDnsRecords(subDomain?: string): Promise<DnsRecord[]> {
  const nameFilter = subDomain ? `&name=${subDomain}.${DOMAIN}` : "";
  return cfFetch<DnsRecord[]>(`/zones/${CF_ZONE_ID()}/dns_records?type=A${nameFilter}`);
}

// Find existing A record for a subdomain
export async function findDnsRecord(subDomain: string): Promise<DnsRecord | null> {
  const records = await listDnsRecords(subDomain);
  return records.find((r) => r.name === `${subDomain}.${DOMAIN}`) ?? null;
}

// Create an A record
export async function createDnsRecord(subDomain: string, ip: string): Promise<DnsRecord> {
  return cfFetch<DnsRecord>(`/zones/${CF_ZONE_ID()}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "A",
      name: `${subDomain}.${DOMAIN}`,
      content: ip,
      ttl: 1, // 1 = automatic
      proxied: true, // Cloudflare proxy for SSL + protection
    }),
  });
}

// Update an existing DNS record
export async function updateDnsRecord(recordId: string, ip: string): Promise<DnsRecord> {
  const record = await cfFetch<DnsRecord>(`/zones/${CF_ZONE_ID()}/dns_records/${recordId}`);
  return cfFetch<DnsRecord>(`/zones/${CF_ZONE_ID()}/dns_records/${recordId}`, {
    method: "PUT",
    body: JSON.stringify({
      type: "A",
      name: record.name,
      content: ip,
      ttl: 1,
      proxied: true,
    }),
  });
}

// Delete a DNS record
export async function deleteDnsRecord(recordId: string): Promise<void> {
  await cfFetch(`/zones/${CF_ZONE_ID()}/dns_records/${recordId}`, {
    method: "DELETE",
  });
}

// Create or update — upsert pattern
export async function ensureDnsRecord(subDomain: string, ip: string): Promise<{ action: string; record: DnsRecord }> {
  const existing = await findDnsRecord(subDomain);

  if (existing) {
    if (existing.content === ip) {
      return { action: "unchanged", record: existing };
    }
    const updated = await updateDnsRecord(existing.id, ip);
    return { action: "updated", record: updated };
  }

  const record = await createDnsRecord(subDomain, ip);
  return { action: "created", record };
}

// Check if a subdomain is available (no existing record)
export async function isDnsAvailable(subDomain: string): Promise<boolean> {
  const record = await findDnsRecord(subDomain);
  return record === null;
}
