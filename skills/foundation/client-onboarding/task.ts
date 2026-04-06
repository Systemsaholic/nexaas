/**
 * Foundation Skill — Client Onboarding
 *
 * Generates identity docs, contracts, and channel registry from
 * a structured input (collected via dashboard wizard, AI chat, or ops).
 *
 * This is NOT an interactive conversation task — it receives structured
 * answers and generates the documents. The conversation UI is handled
 * by the dashboard or Claude Code terminal.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../../../orchestrator/db.js";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

export interface OnboardingInput {
  workspaceId: string;
  businessName: string;
  industry: string;
  businessDescription: string;
  keyPeople: Array<{ name: string; role: string; email: string; handles: string }>;
  brandTone: string;
  neverSay: string[];
  departments: string[];
  approvalGates: Record<string, string>;
  hardLimits: string[];
  escalationRules: Record<string, string>;
  channelPreferences: Record<string, { preferredChannel: string; email: string }>;
  connectedTools: string[];
  timezone: string;
}

export const clientOnboarding = task({
  id: "client-onboarding",
  queue: { name: "foundation", concurrencyLimit: 1 },
  maxDuration: 600,
  run: async (input: OnboardingInput) => {
    const { workspaceId } = input;
    const identityDir = join(NEXAAS_ROOT, "identity", workspaceId);
    mkdirSync(identityDir, { recursive: true });
    mkdirSync(join(NEXAAS_ROOT, "runbooks"), { recursive: true });

    logger.info(`Foundation Skill: generating identity docs for ${workspaceId}`);

    const client = new Anthropic();

    // Generate brand-voice.md
    const brandVoiceResponse = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: "You write business identity documents. Output ONLY the markdown document, no explanations.",
      messages: [{
        role: "user",
        content: `Write a brand-voice.md for "${input.businessName}" (${input.industry}).

Tone: ${input.brandTone}
Never say: ${input.neverSay.join(", ")}
Business description: ${input.businessDescription}

Follow this structure:
# Brand Voice — ${input.businessName}
## How We Communicate
## Writing Guidelines
## What We Never Say
## Signature`,
      }],
    });
    const brandVoice = brandVoiceResponse.content[0].type === "text" ? brandVoiceResponse.content[0].text : "";
    writeFileSync(join(identityDir, "brand-voice.md"), brandVoice);
    logger.info("Generated brand-voice.md");

    // Generate operations docs per department
    for (const dept of input.departments) {
      const opsResponse = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: "You write business operations documents. Output ONLY the markdown document.",
        messages: [{
          role: "user",
          content: `Write a ${dept}-operations.md for "${input.businessName}" (${input.industry}).

Key people: ${input.keyPeople.map((p) => `${p.name} (${p.role}) — ${p.handles}`).join("; ")}
Business: ${input.businessDescription}

Follow this structure:
# ${dept.charAt(0).toUpperCase() + dept.slice(1)} Operations — ${input.businessName}
## How This Department Works
## Priorities
## What the Agent Handles
## What Gets Escalated
## Key Contacts
## Department-Specific Rules`,
        }],
      });
      const ops = opsResponse.content[0].type === "text" ? opsResponse.content[0].text : "";
      writeFileSync(join(identityDir, `${dept}-operations.md`), ops);
      logger.info(`Generated ${dept}-operations.md`);
    }

    // Generate agent-handbook.md
    const handbookResponse = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: "You write business handbooks. Output ONLY the markdown document.",
      messages: [{
        role: "user",
        content: `Write an agent-handbook.md for "${input.businessName}" (${input.industry}).

Business: ${input.businessDescription}
Key people: ${JSON.stringify(input.keyPeople)}
Non-negotiables: ${input.hardLimits.join("; ")}
Timezone: ${input.timezone}

Follow this structure:
# Agent Handbook — ${input.businessName}
## Who We Are
## Our Culture
## Key People
## Non-Negotiables
## Business Hours
## Institutional Knowledge`,
      }],
    });
    const handbook = handbookResponse.content[0].type === "text" ? handbookResponse.content[0].text : "";
    writeFileSync(join(identityDir, "agent-handbook.md"), handbook);
    logger.info("Generated agent-handbook.md");

    // Write behavioral contract
    const yaml = await import("js-yaml");
    const behavioralContract = {
      workspace: workspaceId,
      businessName: input.businessName,
      tone: input.brandTone,
      domain: input.industry,
      approval_gates: input.approvalGates,
      hard_limits: input.hardLimits,
      escalation_rules: input.escalationRules,
      notification_prefs: { channel: "dashboard", mode: "digest_urgent_only" },
    };
    mkdirSync(join(NEXAAS_ROOT, "config"), { recursive: true });
    writeFileSync(
      join(NEXAAS_ROOT, "config", "client-profile.yaml"),
      yaml.dump(behavioralContract, { lineWidth: 120 })
    );
    logger.info("Generated client-profile.yaml");

    // Register channels
    // Dashboard channel (always)
    await query(
      `INSERT INTO channel_registry (workspace_id, channel_id, display_name, direction, criticality, latency, implementation, capabilities, active)
       VALUES ($1, 'dashboard', 'Nexmatic Dashboard', 'two-way', 'standard', 'near-realtime', $2, $3, true)
       ON CONFLICT (workspace_id, channel_id) DO NOTHING`,
      [workspaceId, JSON.stringify({ type: "internal", server: "nexmatic-portal" }), ["markdown", "interactive-buttons"]]
    );

    // Email channels per key person
    for (const person of input.keyPeople) {
      if (person.email) {
        const channelId = `email-${person.name.toLowerCase().replace(/\s+/g, "-")}`;
        await query(
          `INSERT INTO channel_registry (workspace_id, channel_id, display_name, direction, criticality, latency, implementation, capabilities, active)
           VALUES ($1, $2, $3, 'two-way', 'standard', 'async', $4, $5, true)
           ON CONFLICT (workspace_id, channel_id) DO NOTHING`,
          [
            workspaceId, channelId, `Email — ${person.name}`,
            JSON.stringify({ type: "mcp", server: "mcp/email", config: { to: person.email } }),
            ["markdown", "file-attachments"],
          ]
        );
      }
    }

    // Set user channel preferences
    for (const [role, prefs] of Object.entries(input.channelPreferences)) {
      if (prefs.email) {
        await query(
          `INSERT INTO user_channel_preferences (workspace_id, user_email, user_role, preference_type, channel_id)
           VALUES ($1, $2, $3, 'approval', 'dashboard')
           ON CONFLICT (workspace_id, user_email, preference_type) DO NOTHING`,
          [workspaceId, prefs.email, role]
        );
      }
    }

    logger.info(`Foundation Skill complete for ${workspaceId}: ${input.departments.length} departments, ${input.keyPeople.length} contacts`);

    return {
      success: true,
      generated: {
        brandVoice: "brand-voice.md",
        operations: input.departments.map((d) => `${d}-operations.md`),
        handbook: "agent-handbook.md",
        contract: "client-profile.yaml",
        channels: ["dashboard", ...input.keyPeople.filter((p) => p.email).map((p) => `email-${p.name.toLowerCase().replace(/\s+/g, "-")}`)],
        departments: input.departments,
      },
    };
  },
});
