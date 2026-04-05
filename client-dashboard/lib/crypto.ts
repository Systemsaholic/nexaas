import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be at least 32 characters");
  }
  return Buffer.from(key.slice(0, 32), "utf-8");
}

export function encrypt(text: string): string {
  const key = getKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
  let ciphertext = cipher.update(text, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return JSON.stringify({ nonce: nonce.toString("hex"), ciphertext, tag });
}

export function decrypt(encrypted: string): string {
  const key = getKey();
  const { nonce, ciphertext, tag } = JSON.parse(encrypted);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(nonce, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let plaintext = decipher.update(ciphertext, "hex", "utf8");
  plaintext += decipher.final("utf8");
  return plaintext;
}
