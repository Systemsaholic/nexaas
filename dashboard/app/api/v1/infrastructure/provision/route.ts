import {
  createInstance, waitForActive, findNexaasNetwork, attachToNetwork,
  findUbuntuImage, findSshKey, listFlavors, ALLOWED_FLAVORS,
} from "@/lib/ovh";
import { getNextAvailableIp } from "@/lib/ip-allocator";
import { query, queryOne } from "@/lib/db";
import { ok, err } from "@/lib/api-response";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function POST(request: Request) {
  const { workspaceId, adminEmail, flavor, appOrigin, subdomain } = await request.json();

  if (!workspaceId || !adminEmail || !flavor) {
    return err("workspaceId, adminEmail, and flavor are required");
  }

  if (!ALLOWED_FLAVORS.some((f) => f.id === flavor)) {
    return err(`Invalid flavor. Allowed: ${ALLOWED_FLAVORS.map((f) => f.id).join(", ")}`);
  }

  // Check no deploy already running
  const existing = await queryOne(
    `SELECT id FROM deploy_runs WHERE workspace_id = $1 AND status IN ('pending', 'running')`,
    [workspaceId]
  );
  if (existing) return err(`Deploy already in progress for ${workspaceId}`);

  const privateIp = await getNextAvailableIp();
  const region = process.env.OVH_REGION ?? "BHS5";

  // Create deploy run record
  const steps = [
    { step: 1, label: "Creating VPS on OVH", status: "pending" },
    { step: 2, label: "Waiting for VPS to boot", status: "pending" },
    { step: 3, label: "Attaching to private network", status: "pending" },
    { step: 4, label: "Configuring network (Netplan)", status: "pending" },
    { step: 5, label: "Applying hub-and-spoke firewall", status: "pending" },
    { step: 6, label: "Authorizing orchestrator SSH key", status: "pending" },
    { step: 7, label: "Installing prerequisites", status: "pending" },
    { step: 8, label: "Cloning/updating repo", status: "pending" },
    { step: 9, label: "Deploying Trigger.dev stack", status: "pending" },
    { step: 10, label: "Creating user, org, project", status: "pending" },
    { step: 11, label: "Generating access token", status: "pending" },
    { step: 12, label: "Setting up database and dependencies", status: "pending" },
    { step: 13, label: "Starting worker", status: "pending" },
    { step: 14, label: "Finalizing deployment", status: "pending" },
  ];

  const run = await queryOne<{ id: number }>(
    `INSERT INTO deploy_runs
     (workspace_id, vps_ip, admin_email, status, steps, deploy_mode, vps_flavor, private_ip)
     VALUES ($1, $2, $3, 'pending', $4, 'new_vps', $5, $6)
     RETURNING id`,
    [workspaceId, privateIp, adminEmail, JSON.stringify(steps), flavor, privateIp]
  );

  if (!run) return err("Failed to create deploy run", 500);

  // Run provisioning in background
  runProvisionAndDeploy(run.id, workspaceId, adminEmail, flavor, region, privateIp, appOrigin || "http://localhost:3040", subdomain).catch((e) => {
    console.error(`Provision ${run.id} crashed:`, e);
  });

  return ok({ id: run.id }, 201);
}

async function runProvisionAndDeploy(
  runId: number,
  workspaceId: string,
  adminEmail: string,
  flavor: string,
  region: string,
  privateIp: string,
  appOrigin: string,
  subdomain?: string,
) {
  try {
    // Step 1: Create instance on OVH
    await updateStep(runId, 1, "running");
    await updateRun(runId, { status: "running", current_step: 1 });

    const image = await findUbuntuImage(region);
    if (!image) throw new Error(`No Ubuntu 24.04 image found in ${region}`);

    const sshKey = await findSshKey();
    if (!sshKey) throw new Error("No SSH key found in OVH project");

    // Resolve flavor ID (OVH uses UUIDs, not short names)
    const allFlavors = await listFlavors(region);
    const matchedFlavor = allFlavors.find((f) => f.name.startsWith(flavor) || f.id === flavor);
    if (!matchedFlavor) throw new Error(`Flavor ${flavor} not found in ${region}`);

    const instance = await createInstance({
      name: `nexaas-${workspaceId}`,
      flavorId: matchedFlavor.id,
      imageId: image.id,
      sshKeyId: sshKey.id,
      region,
    });

    await updateRun(runId, { ovh_instance_id: instance.id });
    await updateStep(runId, 1, "completed");
    appendLog(runId, `Created OVH instance: ${instance.id} (${instance.name})`);

    // Step 2: Wait for ACTIVE
    await updateStep(runId, 2, "running");
    await updateRun(runId, { current_step: 2 });

    const activeInstance = await waitForActive(instance.id, 600000);
    const publicIp = activeInstance.ipAddresses.find((ip) => ip.type === "public" && ip.version === 4)?.ip;
    if (!publicIp) throw new Error("No public IPv4 assigned to instance");

    await updateRun(runId, { public_ip: publicIp });
    await updateStep(runId, 2, "completed");
    appendLog(runId, `VPS is ACTIVE. Public IP: ${publicIp}`);

    // Step 3: Attach to private network
    await updateStep(runId, 3, "running");
    await updateRun(runId, { current_step: 3 });

    const network = await findNexaasNetwork();
    if (!network) throw new Error("nexaas-lan private network not found in OVH");

    await attachToNetwork(instance.id, network.id, privateIp);
    await updateStep(runId, 3, "completed");
    appendLog(runId, `Attached to ${network.name} with IP ${privateIp}`);

    // Wait for network interface to appear on the VPS
    appendLog(runId, "Waiting 30s for network interface to appear...\n");
    await new Promise((r) => setTimeout(r, 30000));

    // Steps 4-6: Configure VPS via SSH (using public IP)
    const sshTarget = `ubuntu@${publicIp}`;
    const sshOpts = "-o StrictHostKeyChecking=accept-new -o ConnectTimeout=30";

    // Step 4: Netplan config
    await updateStep(runId, 4, "running");
    await updateRun(runId, { current_step: 4 });

    // Auto-detect VLAN interface name (the second NIC, not the public one)
    // Wait a bit for the interface to appear after OVH attaches it
    let vlanIface = "ens4";
    try {
      const ifaces = await sshCmd(sshTarget, sshOpts,
        "ip -o link show | awk -F': ' '{print $2}' | grep -v lo | grep -v '^docker' | grep -v '^br-' | grep -v '^veth'"
      );
      const ifaceList = ifaces.trim().split("\n").map((s) => s.trim()).filter(Boolean);
      appendLog(runId, `Detected interfaces: ${ifaceList.join(", ")}\n`);
      // The VLAN interface is the one that's NOT the primary (first) interface
      if (ifaceList.length >= 2) {
        vlanIface = ifaceList[ifaceList.length - 1]; // last one is usually the VLAN NIC
      }
    } catch {
      appendLog(runId, `WARNING: Could not detect interfaces, defaulting to ens4\n`);
    }

    await sshCmd(sshTarget, sshOpts, `sudo bash -c 'cat > /etc/netplan/60-nexaas-lan.yaml << NETEOF
network:
  version: 2
  ethernets:
    ${vlanIface}:
      addresses:
        - ${privateIp}/24
      routes: []
      dhcp4: false
NETEOF
netplan apply'`);
    await updateStep(runId, 4, "completed");
    appendLog(runId, `Netplan configured: ${vlanIface} = ${privateIp}\n`);

    // Step 5: Firewall
    await updateStep(runId, 5, "running");
    await updateRun(runId, { current_step: 5 });

    await sshCmd(sshTarget, sshOpts, [
      `sudo iptables -A INPUT -i ${vlanIface} -s 10.10.0.10 -j ACCEPT`,
      `sudo iptables -A OUTPUT -o ${vlanIface} -d 10.10.0.10 -j ACCEPT`,
      `sudo iptables -A INPUT -i ${vlanIface} -s 10.10.0.0/24 -j DROP`,
      `sudo iptables -A OUTPUT -o ${vlanIface} -d 10.10.0.0/24 -j DROP`,
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent 2>/dev/null || true",
      "sudo netfilter-persistent save 2>/dev/null || true",
    ].join(" && "));
    await updateStep(runId, 5, "completed");
    appendLog(runId, `Hub-and-spoke firewall applied on ${vlanIface}\n`);

    // Step 6: Authorize orchestrator SSH key for private IP
    await updateStep(runId, 6, "running");
    await updateRun(runId, { current_step: 6 });

    const orchestratorKey = readFileSync("/home/ubuntu/.ssh/id_ed25519.pub", "utf-8").trim();
    await sshCmd(sshTarget, sshOpts,
      `mkdir -p ~/.ssh && grep -qF '${orchestratorKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${orchestratorKey}' >> ~/.ssh/authorized_keys`
    );

    // Verify orchestrator can SSH via private IP
    try {
      await sshCmd(`ubuntu@${privateIp}`, "-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10", "hostname");
      appendLog(runId, `SSH via private IP ${privateIp} verified`);
    } catch {
      appendLog(runId, `WARNING: SSH via private IP ${privateIp} not yet working — Netplan interface might need different name`);
    }

    await updateStep(runId, 6, "completed");

    // Steps 7-14: Run deploy-instance.sh
    appendLog(runId, `\n--- Starting deploy-instance.sh ---\n`);

    const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
    const script = `${nexaasRoot}/scripts/deploy-instance.sh`;

    await new Promise<void>((resolve, reject) => {
      const proc = execFile("bash", [script, workspaceId, privateIp, adminEmail, appOrigin], {
        timeout: 1800000,
        maxBuffer: 10 * 1024 * 1024,
      }, (error) => {
        if (error) reject(error);
        else resolve();
      });

      let currentStep = 7;

      proc.stdout?.on("data", async (chunk: Buffer) => {
        const text = chunk.toString();
        appendLog(runId, text);

        const stepMatch = text.match(/Step (\d+)\/9/);
        if (stepMatch) {
          const scriptStep = parseInt(stepMatch[1], 10);
          const dashStep = scriptStep + 6;
          if (dashStep > currentStep) {
            await updateStep(runId, currentStep, "completed");
            currentStep = dashStep;
            await updateStep(runId, currentStep, "running");
            await updateRun(runId, { current_step: currentStep });
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        appendLog(runId, chunk.toString());
      });
    });

    // Setup Claude Code with CLAUDE.md
    appendLog(runId, `\nSetting up Claude Code...\n`);
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("bash", [`${nexaasRoot}/scripts/setup-instance-claude.sh`, workspaceId, privateIp], {
          timeout: 120000,
        }, (error, stdout, stderr) => {
          appendLog(runId, stdout || "");
          if (stderr) appendLog(runId, stderr);
          if (error) reject(error);
          else resolve();
        });
      });
      appendLog(runId, `Claude Code setup complete\n`);
    } catch (e) {
      appendLog(runId, `WARNING: Claude Code setup failed: ${(e as Error).message}\n`);
    }

    // Mark all steps completed
    for (let i = 1; i <= 14; i++) {
      await updateStep(runId, i, "completed");
    }

    // Create workspace manifest
    const nexaasRoot2 = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
    const manifest = {
      id: workspaceId,
      name: workspaceId.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      workspaceRoot: `/opt/workspaces/${workspaceId}`,
      claudeMd: {
        full: `/opt/workspaces/${workspaceId}/CLAUDE.md`,
        summary: `/opt/workspaces/${workspaceId}/CLAUDE.summary.md`,
        minimal: `/opt/workspaces/${workspaceId}/CLAUDE.minimal.md`,
      },
      skills: [],
      agents: [],
      mcp: { filesystem: "http://localhost:3100" },
      capabilities: { playwright: false, docker: true, bash: true },
      trigger: { projectId: `proj_${workspaceId}`, workerUrl: "http://localhost:3000" },
      network: { privateIp, publicIp: publicIp! },
      ssh: { host: privateIp, user: "ubuntu", port: 22 },
      context: { threadTtlDays: 90, maxTurnsBeforeSummary: 10 },
      ...(subdomain ? { domain: { subdomain, fullDomain: `${subdomain}.${process.env.OVH_DNS_DOMAIN ?? "nexmatic.ca"}`, configuredAt: new Date().toISOString() } } : {}),
    };
    writeFileSync(
      join(nexaasRoot2, "workspaces", `${workspaceId}.workspace.json`),
      JSON.stringify(manifest, null, 2)
    );
    appendLog(runId, `\nWorkspace manifest created: workspaces/${workspaceId}.workspace.json\n`);

    // Collect initial health snapshot
    try {
      const healthOut = await sshCmd(`ubuntu@${privateIp}`, "-o ConnectTimeout=10",
        "free -m | awk '/^Mem:/ {print $2,$3}' && echo '---' && df -BG / | awk 'NR==2 {gsub(/G/,\"\"); print $2,$3}' && echo '---' && docker ps --format '{{.Names}}' | wc -l && echo '---' && docker ps --format '{{.Status}}' | grep -c healthy || echo 0"
      );
      const parts = healthOut.split("---").map((s) => s.trim());
      const [ramTotal, ramUsed] = (parts[0] ?? "0 0").split(/\s+/).map(Number);
      const [diskTotal, diskUsed] = (parts[1] ?? "0 0").split(/\s+/).map(Number);
      const containerCount = parseInt(parts[2] ?? "0", 10);
      const containersHealthy = parseInt(parts[3] ?? "0", 10);

      await query(
        `INSERT INTO ops_health_snapshots
         (workspace_id, ram_total_mb, ram_used_mb, disk_total_gb, disk_used_gb,
          container_count, containers_healthy, worker_active, vps_ip, snapshot_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, NOW())`,
        [workspaceId, ramTotal, ramUsed, diskTotal, diskUsed, containerCount, containersHealthy, privateIp]
      );
      appendLog(runId, `Initial health snapshot collected\n`);
    } catch {
      appendLog(runId, `WARNING: Could not collect initial health snapshot\n`);
    }

    // Configure subdomain + SSL if requested
    if (subdomain && publicIp) {
      appendLog(runId, `\nConfiguring domain: ${subdomain}.${process.env.OVH_DNS_DOMAIN ?? "nexmatic.ca"}...\n`);
      try {
        const { ensureDnsRecord } = await import("@/lib/ovh-dns");
        const dnsResult = await ensureDnsRecord(subdomain, publicIp);
        appendLog(runId, `DNS record ${dnsResult.action}: ${subdomain} → ${publicIp}\n`);

        // Install Caddy and configure reverse proxy on the instance
        const fullDomain = `${subdomain}.${process.env.OVH_DNS_DOMAIN ?? "nexmatic.ca"}`;
        await sshCmd(`ubuntu@${privateIp}`, "-o StrictHostKeyChecking=accept-new -o ConnectTimeout=30", [
          "command -v caddy >/dev/null 2>&1 || (sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl 2>/dev/null && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null && sudo apt-get update 2>/dev/null && sudo apt-get install -y caddy 2>/dev/null)",
          `sudo tee /etc/caddy/Caddyfile > /dev/null << CADDYEOF\n${fullDomain} {\n    reverse_proxy localhost:3001\n}\nCADDYEOF`,
          "sudo systemctl enable caddy 2>/dev/null && sudo systemctl restart caddy",
        ].join(" && "), 120000);
        appendLog(runId, `Caddy configured: ${fullDomain} → localhost:3001 (auto-SSL)\n`);
      } catch (e) {
        appendLog(runId, `WARNING: Domain setup failed: ${(e as Error).message}\n`);
      }
    }

    await updateRun(runId, {
      status: "completed",
      current_step: 14,
      completed_at: new Date().toISOString(),
    });

  } catch (e) {
    const errorMsg = (e as Error).message;
    const currentStep = await getCurrentStep(runId);
    await updateStep(runId, currentStep, "failed");
    await updateRun(runId, {
      status: "failed",
      error: errorMsg,
      completed_at: new Date().toISOString(),
    });
    appendLog(runId, `\nFAILED: ${errorMsg}`);
  }
}

function sshCmd(target: string, opts: string, command: string, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ssh", [...opts.split(" "), target, command], { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`SSH failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
      else resolve(stdout);
    });
  });
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
    `UPDATE deploy_runs SET steps = jsonb_set(steps, $2::text[], $3::jsonb) WHERE id = $1`,
    [runId, `{${stepNum - 1},status}`, JSON.stringify(status)]
  );
}

async function appendLog(runId: number, text: string) {
  await query(
    `UPDATE deploy_runs SET log_output = log_output || $2 WHERE id = $1`,
    [runId, text]
  );
}

async function getCurrentStep(runId: number): Promise<number> {
  const row = await queryOne<{ current_step: number }>(
    `SELECT current_step FROM deploy_runs WHERE id = $1`,
    [runId]
  );
  return row?.current_step ?? 1;
}
