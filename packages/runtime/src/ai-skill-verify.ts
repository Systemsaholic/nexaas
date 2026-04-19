/**
 * Output verification for ai-skill runs.
 *
 * A skill declaring `outputs[].verify` gets its declared outputs checked
 * after the agentic loop finishes but before the run is marked complete.
 * Required failures turn the run into `status: failed`; optional failures
 * log a warning. See issue #28.
 *
 * Supported verification types:
 *   palace_drawer_exists — a drawer was written to {wing, hall, room}
 *                          (defaults to the primary room) for this runId
 *   tool_called          — the specified `tool` was invoked at least once
 *   tool_result_contains — the specified `tool` produced a result matching
 *                          `pattern` (regex, applied case-insensitive by default)
 *   custom               — an arbitrary shell command; exit 0 is pass
 */

import { spawnSync } from "child_process";
import { sql } from "@nexaas/palace";

export interface OutputVerification {
  type: "palace_drawer_exists" | "tool_called" | "tool_result_contains" | "custom";
  required?: boolean;
  wing?: string;
  hall?: string;
  room?: string;
  tool?: string;
  pattern?: string;
  case_sensitive?: boolean;
  command?: string;
  timeout?: number;
  working_directory?: string;
}

export interface VerifiableOutput {
  id: string;
  routing_default?: string;
  verify?: OutputVerification;
}

export interface VerificationResult {
  outputId: string;
  type: string;
  pass: boolean;
  required: boolean;
  reason: string;
}

export interface VerifyParams {
  workspace: string;
  runId: string;
  skillId: string;
  outputs: VerifiableOutput[];
  primaryRoom: { wing: string; hall: string; room: string };
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
}

export async function verifyOutputs(params: VerifyParams): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const output of params.outputs) {
    if (!output.verify) continue;

    const required = output.verify.required ?? true;
    const type = output.verify.type;

    let pass = false;
    let reason = "";

    try {
      switch (type) {
        case "palace_drawer_exists": {
          const wing = output.verify.wing ?? params.primaryRoom.wing;
          const hall = output.verify.hall ?? params.primaryRoom.hall;
          const room = output.verify.room ?? params.primaryRoom.room;
          const rows = await sql<{ count: string }>(
            `SELECT COUNT(*)::text as count FROM nexaas_memory.events
             WHERE run_id = $1 AND workspace = $2
               AND wing = $3 AND hall = $4 AND room = $5`,
            [params.runId, params.workspace, wing, hall, room],
          );
          const count = parseInt(rows[0]?.count ?? "0", 10);
          pass = count > 0;
          reason = pass
            ? `${count} drawer(s) in ${wing}/${hall}/${room}`
            : `no drawers in ${wing}/${hall}/${room} for this run`;
          break;
        }

        case "tool_called": {
          const needle = output.verify.tool;
          if (!needle) {
            pass = false;
            reason = "verify.tool is required for tool_called";
            break;
          }
          const hits = params.toolCalls.filter((tc) => tc.name === needle);
          pass = hits.length > 0;
          reason = pass
            ? `${hits.length} call(s) to ${needle}`
            : `tool '${needle}' was never invoked`;
          break;
        }

        case "tool_result_contains": {
          const needle = output.verify.tool;
          const pattern = output.verify.pattern;
          if (!needle || !pattern) {
            pass = false;
            reason = "verify.tool and verify.pattern are required for tool_result_contains";
            break;
          }
          const flags = output.verify.case_sensitive ? "" : "i";
          let re: RegExp;
          try {
            re = new RegExp(pattern, flags);
          } catch (err) {
            pass = false;
            reason = `invalid regex: ${err instanceof Error ? err.message : String(err)}`;
            break;
          }
          const matches = params.toolCalls.filter(
            (tc) => tc.name === needle && re.test(tc.result),
          );
          pass = matches.length > 0;
          reason = pass
            ? `${matches.length} match(es) for /${pattern}/${flags} in ${needle} results`
            : `no ${needle} result matched /${pattern}/${flags}`;
          break;
        }

        case "custom": {
          const command = output.verify.command;
          if (!command) {
            pass = false;
            reason = "verify.command is required for custom";
            break;
          }
          const r = spawnSync(command, {
            shell: true,
            encoding: "utf-8",
            cwd: output.verify.working_directory,
            timeout: (output.verify.timeout ?? 30) * 1000,
            env: {
              ...process.env,
              NEXAAS_RUN_ID: params.runId,
              NEXAAS_SKILL_ID: params.skillId,
              NEXAAS_OUTPUT_ID: output.id,
            },
          });
          const exitCode = r.status ?? (r.signal ? 124 : 1);
          pass = exitCode === 0;
          reason = pass
            ? "custom verifier exit 0"
            : `custom verifier exit ${exitCode}: ${(r.stderr ?? r.stdout ?? "").toString().trim().slice(0, 200)}`;
          break;
        }

        default: {
          pass = false;
          reason = `unknown verify type: ${type}`;
        }
      }
    } catch (err) {
      pass = false;
      reason = `verify threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    results.push({ outputId: output.id, type, pass, required, reason });
  }

  return results;
}

export function summarizeFailures(results: VerificationResult[]): {
  requiredFailures: VerificationResult[];
  optionalFailures: VerificationResult[];
} {
  return {
    requiredFailures: results.filter((r) => r.required && !r.pass),
    optionalFailures: results.filter((r) => !r.required && !r.pass),
  };
}
