#!/usr/bin/env node
/**
 * Create a Trigger.dev Personal Access Token programmatically.
 *
 * Uses AES-256-GCM encryption matching the Trigger.dev webapp's internal format.
 * Key insight: ENCRYPTION_KEY hex string is used as ASCII bytes (32 chars = 32 bytes),
 * NOT decoded from hex (which would give 16 bytes).
 *
 * Usage:
 *   node scripts/create-trigger-pat.mjs <encryption-key> <user-id> [postgres-container]
 *
 * Example:
 *   node scripts/create-trigger-pat.mjs 859f769290f5c0c43b3892a4ba076c39 cmnjddl4n0001qd1xgqsg9hke trigger-trigger-postgres-1
 *
 * Outputs:
 *   TOKEN=tr_pat_xxxx  (use this as TRIGGER_ACCESS_TOKEN)
 *   SQL file at /tmp/insert-pat.sql (pipe to psql to insert)
 */

import crypto from "node:crypto";
import fs from "node:fs";

const encryptionKey = process.argv[2];
const userId = process.argv[3];
const pgContainer = process.argv[4];

if (!encryptionKey || !userId) {
  console.error("Usage: node create-trigger-pat.mjs <encryption-key> <user-id> [postgres-container]");
  console.error("");
  console.error("  encryption-key:   The ENCRYPTION_KEY from platform/.env (32 hex chars)");
  console.error("  user-id:          Trigger.dev user ID (from User table)");
  console.error("  postgres-container: Optional - auto-insert into DB via docker exec");
  process.exit(1);
}

// CRITICAL: Use the hex string as ASCII bytes, NOT decoded from hex.
// This matches Trigger.dev's internal encryption.
const key = Buffer.from(encryptionKey, "ascii"); // 32 bytes from 32 ASCII chars

if (key.length !== 32) {
  console.error(`ERROR: ENCRYPTION_KEY must be exactly 32 hex characters (got ${encryptionKey.length})`);
  process.exit(1);
}

// Generate token
const tokenValue = "tr_pat_" + crypto.randomBytes(24).toString("hex");

// Hash for lookup
const hashedToken = crypto.createHash("sha256").update(tokenValue).digest("hex");

// Encrypt with AES-256-GCM
const nonce = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
let ciphertext = cipher.update(tokenValue, "utf8", "hex");
ciphertext += cipher.final("hex");
const tag = cipher.getAuthTag().toString("hex");

const encryptedToken = JSON.stringify({
  nonce: nonce.toString("hex"),
  ciphertext,
  tag,
});

// Display values
const obfuscated = tokenValue.slice(0, 11) + "••••••••••••••••••" + tokenValue.slice(-4);
const patId = "pat_" + crypto.randomBytes(8).toString("hex");

// Build SQL
const sql = `INSERT INTO "PersonalAccessToken" (id, name, "userId", "obfuscatedToken", "hashedToken", "encryptedToken", "createdAt", "updatedAt") VALUES ('${patId}', 'automated', '${userId}', '${obfuscated}', '${hashedToken}', '${encryptedToken}'::jsonb, NOW(), NOW());`;

// Output
console.log(`TOKEN=${tokenValue}`);
console.log(`PAT_ID=${patId}`);

// Write SQL to file
fs.writeFileSync("/tmp/insert-pat.sql", sql);
console.log("SQL written to /tmp/insert-pat.sql");

// Auto-insert if postgres container specified
if (pgContainer) {
  const { execSync } = await import("node:child_process");
  try {
    execSync(`docker exec -i ${pgContainer} psql -U postgres -d trigger < /tmp/insert-pat.sql`, { stdio: "inherit" });
    console.log("PAT inserted into database");
  } catch (e) {
    console.error("Failed to insert PAT:", e.message);
    console.error("Run manually: docker exec -i <container> psql -U postgres -d trigger < /tmp/insert-pat.sql");
  }
}
