import OVH from "ovh";

function getClient() {
  return new OVH({
    appKey: process.env.OVH_APP_KEY!,
    appSecret: process.env.OVH_APP_SECRET!,
    consumerKey: process.env.OVH_CONSUMER_KEY!,
    endpoint: "ovh-ca",
  });
}

function api<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const client = getClient();
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, result: T) => {
      if (err) reject(err);
      else resolve(result);
    };
    if (body) {
      (client as any).request(method, path, body, cb);
    } else {
      (client as any).request(method, path, cb);
    }
  });
}

const DOMAIN = process.env.OVH_DNS_DOMAIN ?? "nexmatic.ca";

export interface DnsRecord {
  id: number;
  fieldType: string;
  subDomain: string;
  target: string;
  ttl: number;
}

// List all DNS records for the domain
export async function listDnsRecords(subDomain?: string): Promise<DnsRecord[]> {
  const params = subDomain ? `?subDomain=${subDomain}` : "";
  const ids = await api<number[]>("GET", `/domain/zone/${DOMAIN}/record${params}`);

  const records: DnsRecord[] = [];
  for (const id of ids.slice(0, 50)) {
    try {
      const record = await api<DnsRecord>("GET", `/domain/zone/${DOMAIN}/record/${id}`);
      records.push(record);
    } catch { /* skip */ }
  }
  return records;
}

// Create an A record pointing subdomain to an IP
export async function createDnsRecord(subDomain: string, ip: string): Promise<DnsRecord> {
  const record = await api<DnsRecord>("POST", `/domain/zone/${DOMAIN}/record`, {
    fieldType: "A",
    subDomain,
    target: ip,
    ttl: 300,
  });

  // Refresh the zone to apply changes
  await api("POST", `/domain/zone/${DOMAIN}/refresh`);

  return record;
}

// Update an existing DNS record
export async function updateDnsRecord(recordId: number, ip: string): Promise<void> {
  await api("PUT", `/domain/zone/${DOMAIN}/record/${recordId}`, {
    target: ip,
    ttl: 300,
  });

  await api("POST", `/domain/zone/${DOMAIN}/refresh`);
}

// Delete a DNS record
export async function deleteDnsRecord(recordId: number): Promise<void> {
  await api("DELETE", `/domain/zone/${DOMAIN}/record/${recordId}`);
  await api("POST", `/domain/zone/${DOMAIN}/refresh`);
}

// Find existing A record for a subdomain
export async function findDnsRecord(subDomain: string): Promise<DnsRecord | null> {
  const records = await listDnsRecords(subDomain);
  return records.find((r) => r.fieldType === "A" && r.subDomain === subDomain) ?? null;
}

// Create or update — upsert pattern
export async function ensureDnsRecord(subDomain: string, ip: string): Promise<{ action: string; record: DnsRecord }> {
  const existing = await findDnsRecord(subDomain);

  if (existing) {
    if (existing.target === ip) {
      return { action: "unchanged", record: existing };
    }
    await updateDnsRecord(existing.id, ip);
    return { action: "updated", record: { ...existing, target: ip } };
  }

  const record = await createDnsRecord(subDomain, ip);
  return { action: "created", record };
}
