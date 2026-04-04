import OVH from "ovh";

const PROJECT_ID = process.env.OVH_PROJECT_ID ?? "";

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

// ── Instance Management ─────────────────────────────────────────────────

export interface OvhInstance {
  id: string;
  name: string;
  status: string;
  region: string;
  ipAddresses: Array<{ ip: string; type: string; version: number }>;
  flavor: { id: string; name: string; vcpus: number; ram: number; disk: number };
  image: { id: string; name: string };
  created: string;
}

export interface OvhFlavor {
  id: string;
  name: string;
  vcpus: number;
  ram: number;
  disk: number;
  region: string;
}

export interface OvhImage {
  id: string;
  name: string;
  region: string;
  status: string;
}

export interface OvhSshKey {
  id: string;
  name: string;
  publicKey: string;
}

export interface OvhNetwork {
  id: string;
  name: string;
  type: string;
  vlanId: number;
  status: string;
  regions: Array<{ region: string; status: string }>;
}

export async function listInstances(): Promise<OvhInstance[]> {
  return api("GET", `/cloud/project/${PROJECT_ID}/instance`);
}

export async function getInstance(instanceId: string): Promise<OvhInstance> {
  return api("GET", `/cloud/project/${PROJECT_ID}/instance/${instanceId}`);
}

export async function createInstance(params: {
  name: string;
  flavorId: string;
  imageId: string;
  sshKeyId: string;
  region: string;
  networkId?: string;
}): Promise<OvhInstance> {
  const body: Record<string, unknown> = {
    name: params.name,
    flavorId: params.flavorId,
    imageId: params.imageId,
    sshKeyId: params.sshKeyId,
    region: params.region,
  };

  if (params.networkId) {
    body.networks = [{ networkId: params.networkId }];
  }

  return api("POST", `/cloud/project/${PROJECT_ID}/instance`, body);
}

export async function deleteInstance(instanceId: string): Promise<void> {
  return api("DELETE", `/cloud/project/${PROJECT_ID}/instance/${instanceId}`);
}

export async function waitForActive(instanceId: string, timeoutMs = 600000): Promise<OvhInstance> {
  const start = Date.now();
  const pollInterval = 10000; // 10 seconds

  while (Date.now() - start < timeoutMs) {
    const instance = await getInstance(instanceId);
    if (instance.status === "ACTIVE") return instance;
    if (instance.status === "ERROR") throw new Error(`Instance ${instanceId} entered ERROR state`);
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Timeout waiting for instance ${instanceId} to become ACTIVE`);
}

// ── Network ─────────────────────────────────────────────────────────────

export async function getPrivateNetworks(): Promise<OvhNetwork[]> {
  return api("GET", `/cloud/project/${PROJECT_ID}/network/private`);
}

export async function findNexaasNetwork(): Promise<OvhNetwork | null> {
  const networks = await getPrivateNetworks();
  const name = process.env.OVH_NETWORK_NAME ?? "nexaas-lan";
  return networks.find((n) => n.name === name) ?? null;
}

export interface OvhNetworkSubnet {
  id: string;
  cidr: string;
  gatewayIp: string;
  ipPools: Array<{ start: string; end: string; dhcp: boolean }>;
}

export async function getNetworkSubnets(networkId: string): Promise<OvhNetworkSubnet[]> {
  return api("GET", `/cloud/project/${PROJECT_ID}/network/private/${networkId}/subnet`);
}

export async function attachToNetwork(instanceId: string, networkId: string, ip: string): Promise<unknown> {
  return api("POST", `/cloud/project/${PROJECT_ID}/instance/${instanceId}/interface`, {
    networkId,
    ip,
  });
}

// ── Flavors, Images, SSH Keys ───────────────────────────────────────────

export async function listFlavors(region?: string): Promise<OvhFlavor[]> {
  const path = region
    ? `/cloud/project/${PROJECT_ID}/flavor?region=${region}`
    : `/cloud/project/${PROJECT_ID}/flavor`;
  return api("GET", path);
}

export async function listImages(region?: string): Promise<OvhImage[]> {
  const path = region
    ? `/cloud/project/${PROJECT_ID}/image?region=${region}`
    : `/cloud/project/${PROJECT_ID}/image`;
  return api("GET", path);
}

export async function findUbuntuImage(region: string): Promise<OvhImage | null> {
  const images = await listImages(region);
  // Find Ubuntu 24.04 image
  return images.find((img) =>
    img.name.includes("Ubuntu") && img.name.includes("24.04") && img.region === region
  ) ?? null;
}

export async function listSshKeys(): Promise<OvhSshKey[]> {
  return api("GET", `/cloud/project/${PROJECT_ID}/sshkey`);
}

export async function findSshKey(name?: string): Promise<OvhSshKey | null> {
  const keys = await listSshKeys();
  const keyName = name ?? process.env.OVH_SSH_KEY_NAME ?? "nexaas";
  return keys.find((k) => k.name === keyName) ?? null;
}

// ── Allowed Flavors (for deploy form) ───────────────────────────────────

export const ALLOWED_FLAVORS = [
  { id: "d2-8", label: "Standard (2 vCPU, 8GB RAM, 80GB)", ram: 8192 },
  { id: "b3-16", label: "Pro (4 vCPU, 16GB RAM, 200GB)", ram: 16384 },
  { id: "b3-32", label: "Enterprise (8 vCPU, 32GB RAM, 400GB)", ram: 32768 },
];
