/**
 * nexaas alerts — view and manage notifications.
 *
 * Commands:
 *   nexaas alerts                 Show recent alerts
 *   nexaas alerts test            Send a test notification
 *   nexaas alerts config          Show notification configuration
 */

import pg from "pg";

export async function run(args: string[]) {
  const subcommand = args[0] ?? "list";
  const workspace = process.env.NEXAAS_WORKSPACE ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";

  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

  switch (subcommand) {
    case "list":
    case undefined: {
      const limit = parseInt(args[1] ?? "20", 10);
      const alerts = await pool.query(
        `SELECT content, created_at::text
         FROM nexaas_memory.events
         WHERE workspace = $1 AND wing = 'notifications' AND hall = 'alerts'
         ORDER BY created_at DESC LIMIT $2`,
        [workspace, limit],
      );

      console.log("\n  Recent Alerts\n");

      if (alerts.rows.length === 0) {
        console.log("  (no alerts recorded)\n");
        break;
      }

      for (const row of alerts.rows) {
        try {
          const data = JSON.parse(row.content);
          const icon = data.severity === "critical" ? "!!" : data.severity === "warning" ? " !" : "  ";
          console.log(`  ${icon} [${row.created_at}] ${data.title}`);
          if (data.body) {
            const firstLine = data.body.split("\n")[0];
            console.log(`     ${firstLine.slice(0, 100)}`);
          }
        } catch { /* skip */ }
      }
      console.log("");
      break;
    }

    case "test": {
      console.log("\n  Sending test notification...\n");

      const channels: string[] = [];

      // Telegram
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALERT_CHAT_ID) {
        try {
          const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: process.env.TELEGRAM_ALERT_CHAT_ID,
              text: `🔵 *Test Alert* — ${workspace}\n\nThis is a test notification from \`nexaas alerts test\`.`,
              parse_mode: "Markdown",
            }),
          });
          if (res.ok) channels.push("telegram");
          else console.log(`  Telegram: failed (${res.status})`);
        } catch (e) {
          console.log(`  Telegram: error (${(e as Error).message})`);
        }
      } else {
        console.log("  Telegram: not configured (TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID)");
      }

      // Email
      if (process.env.RESEND_API_KEY && process.env.OPS_ALERT_EMAIL) {
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: process.env.OPS_ALERT_FROM ?? "Nexaas Alerts <alerts@nexmatic.ca>",
              to: process.env.OPS_ALERT_EMAIL.split(",").map(e => e.trim()),
              subject: `[TEST] Nexaas Alert — ${workspace}`,
              text: `This is a test notification from \`nexaas alerts test\`.\n\nWorkspace: ${workspace}\nTime: ${new Date().toISOString()}`,
            }),
          });
          if (res.ok) channels.push("email");
          else console.log(`  Email: failed (${res.status})`);
        } catch (e) {
          console.log(`  Email: error (${(e as Error).message})`);
        }
      } else {
        console.log("  Email: not configured (RESEND_API_KEY + OPS_ALERT_EMAIL)");
      }

      if (channels.length > 0) {
        console.log(`\n  Sent via: ${channels.join(", ")}\n`);
      } else {
        console.log("\n  No notification channels configured.\n");
      }
      break;
    }

    case "config": {
      console.log("\n  Notification Configuration\n");
      console.log(`  Workspace: ${workspace}`);
      console.log("");
      console.log("  Channels:");
      console.log(`    Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? "configured" : "not set (TELEGRAM_BOT_TOKEN)"}`);
      console.log(`    Email:    ${process.env.RESEND_API_KEY && process.env.OPS_ALERT_EMAIL ? `configured → ${process.env.OPS_ALERT_EMAIL}` : "not set (RESEND_API_KEY + OPS_ALERT_EMAIL)"}`);
      console.log("");
      console.log("  Routing:");
      console.log("    Critical → Telegram + Email + Palace");
      console.log("    Warning  → Telegram + Palace");
      console.log("    Info     → Palace only");
      console.log("");
      break;
    }

    default:
      console.log(`
  nexaas alerts — view and manage notifications

  Commands:
    (default)     Show recent alerts
    test          Send a test notification to all configured channels
    config        Show notification configuration and routing
`);
  }

  await pool.end();
}
