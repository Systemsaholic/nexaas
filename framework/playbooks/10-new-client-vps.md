# Playbook 10: New Client VPS Provisioning

Spin up a new client VPS on OVH, attach to the private VLAN, apply hub-and-spoke firewall, and provision the Nexaas workspace.

## Prerequisites

- OVH API credentials (application key, secret, consumer key)
- SSH key uploaded to OVH project
- Access to nexaas-nexmatic orchestrator (10.10.0.10)

## Network Architecture

```
                    Internet
                       │
            ┌──────────┴──────────┐
            │   OVH Public IPs    │
            └──────────┬──────────┘
                       │
    ┌──────────────────┼──────────────────┐
    │          nexaas-lan (VLAN 10)       │
    │          10.10.0.0/24               │
    │                                     │
    │    ┌───────────────────┐            │
    │    │ Orchestrator      │            │
    │    │ 10.10.0.10        │            │
    │    │ (hub)             │            │
    │    └──┬─────┬─────┬───┘            │
    │       │     │     │                 │
    │    ┌──┴┐ ┌──┴┐ ┌──┴┐              │
    │    │.11│ │.12│ │.13│  ...          │
    │    └───┘ └───┘ └───┘              │
    │    (spokes — cannot see each other) │
    └─────────────────────────────────────┘
```

**Hub-and-spoke rule:** Each client VPS can only communicate with 10.10.0.10 (orchestrator) on the private network. Client-to-client traffic is dropped. This prevents lateral movement if one client VPS is compromised.

## OVH Infrastructure Details

| Setting | Value |
|---|---|
| Project | (your OVH project ID) |
| vRack | pn-147563 |
| VLAN | 10 (nexaas-lan) |
| Subnet | 10.10.0.0/24 |
| DHCP range | 10.10.0.2–254 |
| Interface | ens7 (on all instances) |
| Netplan config | /etc/netplan/60-nexaas-lan.yaml |
| Orchestrator IP | 10.10.0.10 |
| Next available IP | Check with `scripts/provision-vps.sh --next-ip` |

---

## Step 1: Create VPS on OVH

### Via OVH Manager (manual)

1. Go to Public Cloud → your project → Instances → Create Instance
2. Select:
   - **Region:** Same as orchestrator (e.g., BHS, GRA)
   - **Image:** Ubuntu 24.04
   - **Flavor:** d2-4 (2 vCPU, 4GB RAM) for starter, d2-8 for standard
   - **SSH Key:** Your uploaded key
   - **Instance name:** `nexaas-{client-slug}` (e.g., `nexaas-acme`)
3. Note the assigned public IP

### Via OVH API (automated — implement after deployment)

```bash
# Future: scripts/provision-vps.sh acme d2-4 BHS
# Calls OVH API to create instance, returns instance ID + public IP
```

---

## Step 2: Attach to Private Network (vRack)

### Via OVH Manager (manual)

1. Go to Public Cloud → your project → Private Networks → nexaas-lan
2. Click "Add Instance" → select the new VPS
3. Assign a static IP: next available 10.10.0.x (e.g., 10.10.0.13)

### Via SSH (configure Netplan on the VPS)

The VLAN interface may need manual Netplan config if DHCP doesn't assign the right IP:

```bash
ssh root@{PUBLIC_IP}

# Create netplan config for the VLAN interface
cat > /etc/netplan/60-nexaas-lan.yaml << 'EOF'
network:
  version: 2
  ethernets:
    ens7:
      addresses:
        - 10.10.0.{N}/24
      routes: []
      dhcp4: false
EOF

# Apply
netplan apply

# Verify
ping -c 3 10.10.0.10  # Should reach orchestrator
```

---

## Step 3: Apply Hub-and-Spoke Firewall

On the **new client VPS**, restrict private network traffic to orchestrator only:

```bash
ssh root@{PUBLIC_IP}

# Allow traffic to/from orchestrator (10.10.0.10) on VLAN interface
iptables -A INPUT  -i ens7 -s 10.10.0.10 -j ACCEPT
iptables -A OUTPUT -o ens7 -d 10.10.0.10 -j ACCEPT

# Drop all other private network traffic (client-to-client)
iptables -A INPUT  -i ens7 -s 10.10.0.0/24 -j DROP
iptables -A OUTPUT -o ens7 -d 10.10.0.0/24 -j DROP

# Persist rules across reboots
apt-get install -y iptables-persistent
netfilter-persistent save
```

### Verify firewall

From the new VPS:
```bash
ping -c 1 10.10.0.10   # Should succeed (orchestrator)
ping -c 1 10.10.0.11   # Should fail (other client)
ping -c 1 10.10.0.12   # Should fail (other client)
```

From the orchestrator:
```bash
ssh ubuntu@10.10.0.{N} "hostname"   # Should succeed
```

---

## Step 4: Configure Base Software

```bash
ssh root@{PUBLIC_IP}

# Update system
apt-get update && apt-get upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Install Docker (if workspace needs it)
curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu

# Install PostgreSQL 16
apt-get install -y postgresql-16
sudo -u postgres createuser -s ubuntu
sudo -u postgres createdb nexaas

# Set DATABASE_URL
echo 'export DATABASE_URL=postgresql://ubuntu@localhost/nexaas' >> /home/ubuntu/.bashrc
```

---

## Step 5: Create Workspace Manifest

On your **local dev machine** (where the nexaas repo lives):

```bash
cd /path/to/nexaas

# Copy template
cp templates/workspace.workspace.json workspaces/{client-id}.workspace.json
```

Fill in:

```json
{
  "id": "{client-id}",
  "name": "{Client Name}",
  "workspaceRoot": "/opt/workspaces/{client-id}",
  "skills": [],
  "agents": [],
  "mcp": {
    "filesystem": "http://localhost:3100"
  },
  "capabilities": {
    "playwright": false,
    "docker": true,
    "bash": true
  },
  "trigger": {
    "projectId": "proj_{client_id}",
    "workerUrl": "http://localhost:3000"
  },
  "network": {
    "privateIp": "10.10.0.{N}",
    "publicIp": "{PUBLIC_IP}"
  },
  "ssh": {
    "host": "10.10.0.{N}",
    "user": "ubuntu",
    "port": 22
  },
  "context": {
    "threadTtlDays": 90,
    "maxTurnsBeforeSummary": 10
  }
}
```

Commit and push:
```bash
git add workspaces/{client-id}.workspace.json
git commit -m "feat: add {client-name} workspace"
git push
```

---

## Step 6: Provision Nexaas Workspace

From the **orchestrator** (10.10.0.10):

```bash
cd /opt/nexaas
git pull  # Get the new workspace manifest

# Run provisioning script (uses private IP for SSH)
./scripts/provision-workspace.sh {client-id} 10.10.0.{N}
```

This:
- Creates workspace directory on the client VPS
- Syncs subscribed skills (read-only)
- Syncs MCP configs
- Installs Trigger.dev worker
- Configures and starts systemd service

---

## Step 7: Initialize Trigger.dev on Client

```bash
ssh ubuntu@10.10.0.{N}

# Initialize the Trigger.dev platform stack
cd /opt/nexaas/platform
cp .env.example .env
# Fill in: TRIGGER_DB_PASSWORD, TRIGGER_SECRET_KEY, etc.
docker compose up -d

# Verify Trigger.dev is running
curl http://localhost:3040  # Should return Trigger.dev dashboard

# Configure the worker .env
cd /opt/nexaas
cp .env.example .env
# Fill in:
#   TRIGGER_SECRET_KEY (from Trigger.dev dashboard)
#   TRIGGER_API_URL=http://localhost:3040
#   TRIGGER_PROJECT_REF (create project in Trigger.dev dashboard)
#   DATABASE_URL=postgresql://ubuntu@localhost/nexaas
#   ANTHROPIC_API_KEY
#   NEXAAS_WORKSPACE={client-id}
#   WORKSPACE_ROOT=/opt/workspaces/{client-id}
#   NEXAAS_CORE_WEBHOOK_URL=http://10.10.0.10:8450/api/escalate

# Apply database schema
psql nexaas < /opt/nexaas/database/schema.sql

# Start the worker
sudo systemctl start nexaas-worker
sudo systemctl enable nexaas-worker

# Verify
journalctl -u nexaas-worker -f  # Should show worker connecting
```

---

## Step 8: Verify End-to-End

From the **orchestrator**:

```bash
# SSH works over private network
ssh ubuntu@10.10.0.{N} "hostname"

# Worker is registered (check Trigger.dev dashboard on client)
ssh ubuntu@10.10.0.{N} "curl -s http://localhost:3040/api/v1/workers | head -20"
```

From the **client VPS**:

```bash
# Escalation webhook reaches orchestrator
curl -s -X POST http://10.10.0.10:8450/api/escalate \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"{client-id}","taskId":"test","error":"test","runId":"test","timestamp":"2026-01-01T00:00:00Z"}'

# Should return 200
```

---

## Step 9: Client Onboarding

Once infrastructure is confirmed:

1. Set up the client's workspace (agents, registries, skills) — see Playbook 01
2. Configure MCP servers for the client's integrations
3. Enable skills in the workspace manifest
4. Test a skill run via Trigger.dev dashboard

---

## Quick Reference

| Step | Command | Where |
|---|---|---|
| Create VPS | OVH Manager or API | OVH |
| Attach to VLAN | OVH Manager → Private Networks | OVH |
| Configure IP | `netplan apply` | Client VPS |
| Apply firewall | `iptables` + `netfilter-persistent save` | Client VPS |
| Create manifest | Edit `workspaces/{id}.workspace.json` | Dev machine |
| Provision | `./scripts/provision-workspace.sh {id} 10.10.0.{N}` | Orchestrator |
| Init Trigger.dev | `docker compose up -d` + configure `.env` | Client VPS |
| Start worker | `systemctl start nexaas-worker` | Client VPS |
| Verify | `ssh`, `curl`, check Trigger.dev dashboard | Orchestrator |

---

## Automation Status

| Step | Status | Future |
|---|---|---|
| VPS creation | Manual (OVH Manager) | `scripts/provision-vps.sh` via OVH API |
| VLAN attachment | Manual | Automated via OVH API |
| IP assignment | Manual (Netplan) | Auto-assigned from DHCP range |
| Firewall rules | Manual (iptables) | `scripts/firewall-rules.sh` template |
| Manifest creation | Manual (copy template) | CLI wizard |
| Software provisioning | Automated (`provision-workspace.sh`) | Done |
| Trigger.dev init | Semi-manual (docker compose + .env) | Fully automated |

The goal is to get from "new client signed" to "running workspace" in under 30 minutes. Steps 1-3 (OVH + VLAN + firewall) will be automated with `provision-vps.sh` once the orchestrator is deployed and tested.
