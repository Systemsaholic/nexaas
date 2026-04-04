import { queryAll } from "./db";

const SUBNET = "10.10.0";
const RESERVED = new Set([1, 10, 11, 12]); // gateway, orchestrator, envirotem, fairway
const MIN_IP = 13;
const MAX_IP = 254;

export async function getNextAvailableIp(): Promise<string> {
  // Get all IPs currently in use from health snapshots
  const healthIps = await queryAll<{ vps_ip: string }>(
    `SELECT DISTINCT vps_ip FROM ops_health_snapshots WHERE vps_ip IS NOT NULL`
  );

  // Also check in-progress deploys
  const deployIps = await queryAll<{ private_ip: string }>(
    `SELECT private_ip FROM deploy_runs WHERE private_ip IS NOT NULL AND status IN ('pending', 'running')`
  );

  const usedOctets = new Set<number>();

  for (const row of healthIps) {
    const octet = parseInt(row.vps_ip.split(".")[3], 10);
    if (!isNaN(octet)) usedOctets.add(octet);
  }
  for (const row of deployIps) {
    if (row.private_ip) {
      const octet = parseInt(row.private_ip.split(".")[3], 10);
      if (!isNaN(octet)) usedOctets.add(octet);
    }
  }

  // Add reserved IPs
  for (const r of RESERVED) usedOctets.add(r);

  // Find next available
  for (let i = MIN_IP; i <= MAX_IP; i++) {
    if (!usedOctets.has(i)) {
      return `${SUBNET}.${i}`;
    }
  }

  throw new Error("No available IPs in 10.10.0.0/24 subnet");
}
