import { query, queryAll, queryOne } from "@/lib/db";
import { ok, err } from "@/lib/api-response";

const DEPLOY_STEPS = [
  { step: 1, label: "Installing prerequisites" },
  { step: 2, label: "Cloning/updating repo" },
  { step: 3, label: "Deploying Trigger.dev stack" },
  { step: 4, label: "Creating user, org, project, environment" },
  { step: 5, label: "Generating access token" },
  { step: 6, label: "Retrieving project credentials" },
  { step: 7, label: "Setting up database and dependencies" },
  { step: 8, label: "Starting worker" },
  { step: 9, label: "Finalizing deployment" },
];

export async function GET() {
  try {
    const runs = await queryAll(
      `SELECT * FROM deploy_runs ORDER BY started_at DESC LIMIT 20`
    );
    return ok(runs);
  } catch (e) {
    return err(`Failed to list deploys: ${(e as Error).message}`, 500);
  }
}

export async function POST(request: Request) {
  try {
    const { workspaceId, vpsIp, adminEmail, appOrigin } = await request.json();

    if (!workspaceId || !vpsIp || !adminEmail) {
      return err("workspaceId, vpsIp, and adminEmail are required");
    }

    // Check no deploy already running for this workspace
    const existing = await queryOne(
      `SELECT id FROM deploy_runs WHERE workspace_id = $1 AND status IN ('pending', 'running')`,
      [workspaceId]
    );
    if (existing) {
      return err(`Deploy already in progress for ${workspaceId}`);
    }

    const steps = DEPLOY_STEPS.map((s) => ({ ...s, status: "pending" }));

    const result = await queryOne<{ id: number }>(
      `INSERT INTO deploy_runs (workspace_id, vps_ip, admin_email, status, steps)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING id`,
      [workspaceId, vpsIp, adminEmail, JSON.stringify(steps)]
    );

    if (!result) return err("Failed to create deploy run", 500);

    // Kick off the deploy in the background
    const origin = appOrigin || "http://localhost:3040";
    runDeploy(result.id, workspaceId, vpsIp, adminEmail, origin).catch((e) => {
      console.error(`Deploy ${result.id} crashed:`, e);
    });

    return ok({ id: result.id }, 201);
  } catch (e) {
    return err(`Failed to start deploy: ${(e as Error).message}`, 500);
  }
}

async function runDeploy(
  runId: number,
  workspaceId: string,
  vpsIp: string,
  adminEmail: string,
  appOrigin: string
) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  await updateRun(runId, { status: "running", current_step: 1 });
  await updateStep(runId, 1, "running");

  const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
  const script = `${nexaasRoot}/scripts/deploy-instance.sh`;

  try {
    const proc = execFile(
      "bash",
      [script, workspaceId, vpsIp, adminEmail, appOrigin],
      { timeout: 1800000, maxBuffer: 10 * 1024 * 1024 },
      () => {} // callback handled by promise
    );

    let fullOutput = "";
    let currentStep = 1;

    proc.stdout?.on("data", async (chunk: Buffer) => {
      const text = chunk.toString();
      fullOutput += text;

      // Parse step progress from deploy script output
      const stepMatch = text.match(/Step (\d+)\/9/);
      if (stepMatch) {
        const newStep = parseInt(stepMatch[1], 10);
        if (newStep > currentStep) {
          await updateStep(runId, currentStep, "completed");
          currentStep = newStep;
          await updateStep(runId, currentStep, "running");
          await updateRun(runId, { current_step: currentStep, log_output: fullOutput });
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      fullOutput += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Deploy script exited with code ${code}`));
      });
      proc.on("error", reject);
    });

    // Mark all remaining steps as completed
    for (let i = 1; i <= 9; i++) {
      await updateStep(runId, i, "completed");
    }
    await updateRun(runId, {
      status: "completed",
      current_step: 9,
      log_output: fullOutput,
      completed_at: new Date().toISOString(),
    });
  } catch (e) {
    const errorMsg = (e as Error).message;
    await updateStep(runId, await getCurrentStep(runId), "failed");
    await updateRun(runId, {
      status: "failed",
      error: errorMsg,
      completed_at: new Date().toISOString(),
    });
  }
}

async function updateRun(runId: number, fields: Record<string, unknown>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${i}`);
    values.push(value);
    i++;
  }
  values.push(runId);
  await query(`UPDATE deploy_runs SET ${sets.join(", ")} WHERE id = $${i}`, values);
}

async function updateStep(runId: number, stepNum: number, status: string) {
  await query(
    `UPDATE deploy_runs
     SET steps = jsonb_set(
       steps,
       $2::text[],
       $3::jsonb
     )
     WHERE id = $1`,
    [
      runId,
      `{${stepNum - 1},status}`,
      JSON.stringify(status),
    ]
  );
}

async function getCurrentStep(runId: number): Promise<number> {
  const row = await queryOne<{ current_step: number }>(
    `SELECT current_step FROM deploy_runs WHERE id = $1`,
    [runId]
  );
  return row?.current_step ?? 1;
}
