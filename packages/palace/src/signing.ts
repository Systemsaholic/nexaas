/**
 * ed25519 operator signing for privileged WAL entries.
 *
 * Privileged actions (skill install, contract edits, waitpoint resolutions,
 * WAL redactions) are signed by the operator who authorized them.
 * Signatures bind to the WAL chain position by including prev_hash.
 */

import { createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { sql, sqlOne } from "./db.js";

export interface OperatorKey {
  operatorId: string;
  keyId: string;
  publicKey: Buffer;
  keySource: string;
}

export function generateOperatorKeyPair(keyDir?: string): {
  publicKey: string;
  privateKey: string;
  keyPath: string;
} {
  const dir = keyDir ?? join(process.env.HOME ?? "/home/ubuntu", ".nexaas");
  const keyPath = join(dir, "operator-key.ed25519");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  writeFileSync(keyPath, privateKey);
  chmodSync(keyPath, 0o600);
  writeFileSync(`${keyPath}.pub`, publicKey);

  return { publicKey, privateKey, keyPath };
}

export function loadPrivateKey(keyPath?: string): ReturnType<typeof createPrivateKey> {
  const path = keyPath ?? join(process.env.HOME ?? "/home/ubuntu", ".nexaas", "operator-key.ed25519");
  const pem = readFileSync(path, "utf-8");
  return createPrivateKey(pem);
}

export function signPayload(
  payload: string,
  privateKey: ReturnType<typeof createPrivateKey>,
): Buffer {
  return sign(null, Buffer.from(payload), privateKey);
}

export function verifySignature(
  payload: string,
  signature: Buffer,
  publicKeyPem: string,
): boolean {
  const pubKey = createPublicKey(publicKeyPem);
  return verify(null, Buffer.from(payload), pubKey, signature);
}

export function canonicalSigningPayload(parts: {
  workspace: string;
  op: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
  prevHash: string;
}): string {
  return [
    parts.workspace,
    parts.op,
    parts.actor,
    JSON.stringify(parts.payload, Object.keys(parts.payload).sort()),
    parts.createdAt,
    parts.prevHash,
  ].join("|");
}

export async function getOperatorKeyId(operatorEmail: string): Promise<string | null> {
  const row = await sqlOne<{ id: string }>(
    `SELECT ok.id FROM nexaas_memory.operator_keys ok
     JOIN nexaas_memory.operators o ON o.id = ok.operator_id
     WHERE o.email = $1 AND ok.retired_at IS NULL
     LIMIT 1`,
    [operatorEmail],
  );
  return row?.id ?? null;
}

export async function signWalEntry(entry: {
  workspace: string;
  op: string;
  actor: string;
  payload: Record<string, unknown>;
  prevHash: string;
  createdAt: string;
  operatorEmail: string;
  privateKeyPath?: string;
}): Promise<{
  signedByKeyId: string | null;
  signature: Buffer | null;
  signedContentHash: string;
}> {
  const canonical = canonicalSigningPayload({
    workspace: entry.workspace,
    op: entry.op,
    actor: entry.actor,
    payload: entry.payload,
    createdAt: entry.createdAt,
    prevHash: entry.prevHash,
  });

  const keyId = await getOperatorKeyId(entry.operatorEmail);
  if (!keyId) {
    return { signedByKeyId: null, signature: null, signedContentHash: canonical };
  }

  try {
    const privateKey = loadPrivateKey(entry.privateKeyPath);
    const signature = signPayload(canonical, privateKey);
    return { signedByKeyId: keyId, signature, signedContentHash: canonical };
  } catch {
    return { signedByKeyId: null, signature: null, signedContentHash: canonical };
  }
}
