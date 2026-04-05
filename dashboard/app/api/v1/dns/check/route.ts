import { findDnsRecord } from "@/lib/ovh-dns";
import { loadAllManifests } from "@/lib/manifests";
import { ok, err } from "@/lib/api-response";

// GET: Check if a subdomain is available
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const subdomain = searchParams.get("subdomain");

  if (!subdomain) return err("subdomain parameter required");

  try {
    // Check 1: DNS record exists on OVH
    const dnsRecord = await findDnsRecord(subdomain);
    if (dnsRecord) {
      return ok({ available: false, reason: "DNS record already exists", target: dnsRecord.target });
    }

    // Check 2: Any workspace manifest already claims this subdomain
    const manifests = await loadAllManifests();
    for (const m of manifests) {
      if ((m as any).domain?.subdomain === subdomain) {
        return ok({ available: false, reason: `Already assigned to workspace: ${m.id}` });
      }
    }

    return ok({ available: true, subdomain });
  } catch (e) {
    return err(`DNS check failed: ${(e as Error).message}`, 500);
  }
}
