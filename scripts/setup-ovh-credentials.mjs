#!/usr/bin/env node
/**
 * Setup OVH API credentials for Nexaas.
 *
 * Step 1: Register your app at https://ca.api.ovh.com/createApp
 *         to get OVH_APP_KEY and OVH_APP_SECRET.
 *
 * Step 2: Run this script to get a consumer key:
 *         node scripts/setup-ovh-credentials.mjs <app-key> <app-secret>
 *
 * Step 3: Visit the URL it prints, click "Authorize".
 *
 * Step 4: Add all three values to dashboard/.env.local
 */

const appKey = process.argv[2];
const appSecret = process.argv[3];

if (!appKey || !appSecret) {
  console.error("Usage: node scripts/setup-ovh-credentials.mjs <app-key> <app-secret>");
  console.error("");
  console.error("Get your app key and secret from: https://ca.api.ovh.com/createApp");
  process.exit(1);
}

const PROJECT_ID = "a98eba53a12b4964b6d369af55305c43";

// Request consumer key with scopes for Public Cloud management
const accessRules = [
  // Instance management
  { method: "GET", path: `/cloud/project/${PROJECT_ID}/*` },
  { method: "POST", path: `/cloud/project/${PROJECT_ID}/*` },
  { method: "PUT", path: `/cloud/project/${PROJECT_ID}/*` },
  { method: "DELETE", path: `/cloud/project/${PROJECT_ID}/*` },
  // Project info
  { method: "GET", path: `/cloud/project/${PROJECT_ID}` },
  // vRack
  { method: "GET", path: `/vrack/*` },
  { method: "POST", path: `/vrack/*` },
  // DNS zone management
  { method: "GET", path: `/domain/zone/*` },
  { method: "POST", path: `/domain/zone/*` },
  { method: "PUT", path: `/domain/zone/*` },
  { method: "DELETE", path: `/domain/zone/*` },
  // Domain info
  { method: "GET", path: `/domain/*` },
];

async function main() {
  console.log("Requesting consumer key from OVH API...\n");

  const res = await fetch("https://ca.api.ovh.com/1.0/auth/credential", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ovh-Application": appKey,
    },
    body: JSON.stringify({
      accessRules,
      redirection: "https://ca.api.ovh.com/",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`OVH API error (${res.status}): ${text}`);
    process.exit(1);
  }

  const data = await res.json();

  console.log("===========================================");
  console.log("  OVH API Credential Setup");
  console.log("===========================================");
  console.log("");
  console.log("1. Open this URL in your browser and click 'Authorize':");
  console.log("");
  console.log(`   ${data.validationUrl}`);
  console.log("");
  console.log("2. After authorizing, add these to dashboard/.env.local:");
  console.log("");
  console.log(`   OVH_APP_KEY=${appKey}`);
  console.log(`   OVH_APP_SECRET=${appSecret}`);
  console.log(`   OVH_CONSUMER_KEY=${data.consumerKey}`);
  console.log(`   OVH_PROJECT_ID=${PROJECT_ID}`);
  console.log("");
  console.log("===========================================");
  console.log("");
  console.log("Consumer key state:", data.state);
  console.log("You MUST visit the URL above before the key becomes active.");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
