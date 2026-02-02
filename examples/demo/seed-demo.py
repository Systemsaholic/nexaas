"""Seed the gateway SQLite DB with comprehensive demo data for screenshots."""

import sqlite3
import uuid
import json
import random
from datetime import datetime, timedelta, timezone

DB_PATH = "/app/data/nexaas.db"

now = datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat()


def uid() -> str:
    return str(uuid.uuid4())


def main():
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")

    # =========================================================================
    # TOKEN USAGE — 35 rows across all agents, models, sources, over 14 days
    # =========================================================================
    usage_rows = [
        # --- Director: chat, event_engine ---
        ("director", "claude-sonnet-4-20250514", "chat", 1240, 580, 200, 0, 0.006, -0.1),
        ("director", "claude-sonnet-4-20250514", "event_engine", 890, 320, 0, 0, 0.004, -0.5),
        ("director", "claude-sonnet-4-20250514", "chat", 2100, 980, 500, 100, 0.011, -1.2),
        ("director", "claude-opus-4-20250514", "chat", 800, 400, 0, 0, 0.042, -2.0),
        ("director", "claude-sonnet-4-20250514", "event_engine", 1500, 600, 300, 0, 0.007, -3.5),
        # --- Content Writer: heavy usage, multiple models ---
        ("content-writer", "claude-sonnet-4-20250514", "chat", 3200, 1800, 800, 200, 0.018, -0.3),
        ("content-writer", "claude-sonnet-4-20250514", "worker", 2100, 1400, 0, 0, 0.013, -1.0),
        ("content-writer", "claude-haiku-3-20250414", "chat", 1500, 900, 0, 0, 0.002, -1.5),
        ("content-writer", "claude-sonnet-4-20250514", "chat", 4500, 2800, 1200, 400, 0.028, -2.3),
        ("content-writer", "claude-sonnet-4-20250514", "worker", 3800, 2200, 600, 0, 0.022, -3.0),
        ("content-writer", "claude-haiku-3-20250414", "worker", 2000, 1100, 0, 0, 0.003, -4.5),
        ("content-writer", "claude-sonnet-4-20250514", "chat", 1800, 1000, 0, 0, 0.010, -6.0),
        # --- Email Manager ---
        ("email-manager", "claude-sonnet-4-20250514", "chat", 1800, 950, 400, 0, 0.010, -0.2),
        ("email-manager", "claude-sonnet-4-20250514", "worker", 2400, 1100, 0, 200, 0.012, -0.8),
        ("email-manager", "claude-sonnet-4-20250514", "event_engine", 600, 280, 0, 0, 0.003, -1.7),
        ("email-manager", "claude-sonnet-4-20250514", "chat", 3100, 1500, 700, 0, 0.016, -3.2),
        ("email-manager", "claude-haiku-3-20250414", "worker", 900, 400, 0, 0, 0.001, -5.0),
        ("email-manager", "claude-sonnet-4-20250514", "event_engine", 1200, 550, 0, 0, 0.006, -7.0),
        # --- Social Media ---
        ("social-media", "claude-sonnet-4-20250514", "chat", 2200, 1300, 500, 150, 0.014, -0.4),
        ("social-media", "claude-sonnet-4-20250514", "worker", 1600, 800, 0, 0, 0.009, -1.1),
        ("social-media", "claude-haiku-3-20250414", "chat", 900, 500, 0, 0, 0.001, -2.5),
        ("social-media", "claude-sonnet-4-20250514", "chat", 2800, 1600, 900, 300, 0.018, -4.0),
        ("social-media", "claude-sonnet-4-20250514", "worker", 1900, 1000, 0, 0, 0.011, -5.5),
        ("social-media", "claude-sonnet-4-20250514", "event_engine", 700, 350, 0, 0, 0.004, -8.0),
        # --- Analytics: heavy reads, cache-heavy ---
        ("analytics", "claude-sonnet-4-20250514", "chat", 1800, 700, 1200, 0, 0.008, -0.15),
        ("analytics", "claude-sonnet-4-20250514", "event_engine", 3400, 1500, 2000, 500, 0.017, -0.6),
        ("analytics", "claude-sonnet-4-20250514", "worker", 2800, 1200, 1500, 0, 0.015, -1.8),
        ("analytics", "claude-opus-4-20250514", "chat", 1200, 600, 0, 0, 0.063, -2.8),
        ("analytics", "claude-sonnet-4-20250514", "event_engine", 4200, 1800, 2500, 800, 0.024, -4.2),
        ("analytics", "claude-haiku-3-20250414", "worker", 5000, 2500, 0, 0, 0.005, -6.5),
        ("analytics", "claude-sonnet-4-20250514", "chat", 2200, 900, 800, 0, 0.012, -9.0),
        # --- Spread across older days for daily chart ---
        ("director", "claude-sonnet-4-20250514", "chat", 1000, 500, 0, 0, 0.005, -10.0),
        ("content-writer", "claude-sonnet-4-20250514", "worker", 2600, 1600, 0, 0, 0.016, -11.5),
        ("email-manager", "claude-sonnet-4-20250514", "chat", 1400, 700, 300, 0, 0.008, -12.0),
        ("social-media", "claude-sonnet-4-20250514", "chat", 1100, 550, 0, 0, 0.006, -13.0),
    ]

    for agent, model, source, inp, out, cache_r, cache_c, cost, days_ago in usage_rows:
        created = now + timedelta(days=days_ago, minutes=random.randint(-120, 120))
        db.execute(
            "INSERT INTO token_usage (workspace, agent, session_id, source, model, "
            "input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, "
            "cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("BrightWave Digital", agent, None, source, model,
             inp, out, cache_r, cache_c, cost, iso(created)),
        )

    # =========================================================================
    # EVENTS — 10 rows covering every status and condition type
    # =========================================================================
    event_data = [
        # (description, agent, status, cond_type, cond_expr, action_type, run_count, fail_count, consec_fails, priority)
        ("Weekly Analytics Report", "analytics", "active", "cron", "0 9 * * 1", "claude_chat", 8, 0, 0, 3),
        ("Email Drip: NovaPay Onboard", "email-manager", "active", "cron", "0 8 * * *", "claude_chat", 14, 1, 0, 2),
        ("Social Post: Greenleaf Spring", "social-media", "active", "cron", "0 10 * * 2,4", "claude_chat", 6, 0, 0, 5),
        ("Content Review Reminder", "content-writer", "active", "cron", "0 14 * * 3", "webhook", 4, 0, 0, 5),
        ("Campaign Budget Alert", "director", "active", "threshold", "budget_remaining < 500", "claude_chat", 2, 0, 0, 1),
        ("Client Onboarding Checklist", "director", "paused", "manual", "trigger", "script", 0, 0, 0, 5),
        ("Monthly Billing Summary", "analytics", "active", "cron", "0 6 1 * *", "claude_chat", 3, 0, 0, 4),
        ("Failed: Broken Webhook", "email-manager", "failed", "cron", "0 12 * * *", "webhook", 5, 3, 3, 5),
        ("Expired Promo Blast", "social-media", "expired", "cron", "0 9 15 3 *", "claude_chat", 1, 0, 0, 7),
        ("VeloCity Daily Digest", "director", "active", "cron", "0 7 * * 1-5", "claude_chat", 22, 2, 0, 3),
    ]

    event_ids = []
    for desc, agent, status, cond_type, cond_expr, action_type, runs, fails, consec, prio in event_data:
        eid = uid()
        event_ids.append(eid)
        created = now - timedelta(days=random.randint(5, 30))
        next_eval = now + timedelta(hours=random.randint(1, 96))
        last_run = now - timedelta(hours=random.randint(1, 48)) if runs > 0 else None
        db.execute(
            "INSERT INTO events (id, type, condition_type, condition_expr, next_eval_at, "
            "action_type, action_config, status, run_count, fail_count, consecutive_fails, "
            "max_retries, priority, created_at, updated_at, workspace, agent, description, "
            "last_run_at, last_result) "
            "VALUES (?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?)",
            (eid, cond_type, cond_expr, iso(next_eval), action_type,
             json.dumps({"prompt": f"Execute: {desc}"}),
             status, runs, fails, consec, prio,
             iso(created), iso(now),
             "BrightWave Digital", agent, desc,
             iso(last_run) if last_run else None,
             "success" if consec == 0 and runs > 0 else ("error" if consec > 0 else None)),
        )

    # =========================================================================
    # EVENT RUNS — 15 rows tied to events above
    # =========================================================================
    run_results = ["success", "success", "success", "success", "error"]
    for i, eid in enumerate(event_ids[:7]):
        for j in range(random.randint(1, 3)):
            started = now - timedelta(days=random.randint(0, 10), hours=random.randint(0, 23))
            duration = random.randint(800, 45000)
            result = random.choice(run_results)
            completed = started + timedelta(milliseconds=duration)
            db.execute(
                "INSERT INTO event_runs (event_id, started_at, completed_at, result, "
                "output, duration_ms, error, worker_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (eid, iso(started), iso(completed), result,
                 json.dumps({"message": f"Run {j+1} for event"}) if result == "success" else None,
                 duration,
                 "Connection timeout after 30s" if result == "error" else None,
                 f"worker-{random.randint(1, 3)}"),
            )

    # =========================================================================
    # QUEUE JOBS — 12 jobs in every status
    # =========================================================================
    queue_jobs = [
        # (desc, agent, action_type, status, hours_ago, concurrency_key, priority)
        ("Generate weekly email report", "email-manager", "claude_chat", "completed", 6, "email", 3),
        ("Draft Instagram captions batch", "social-media", "claude_chat", "completed", 5, "social", 5),
        ("Compile Q1 campaign ROI report", "analytics", "claude_chat", "completed", 8, "analytics", 2),
        ("Write blog: Spring Garden Tips", "content-writer", "claude_chat", "completed", 4, "content", 5),
        ("Send Greenleaf newsletter", "email-manager", "claude_chat", "completed", 3, "email", 2),
        ("Analyze VeloCity ad spend", "analytics", "claude_chat", "running", 1, "analytics", 3),
        ("Schedule LinkedIn posts (week 20)", "social-media", "claude_chat", "running", 0.5, "social", 5),
        ("Draft NovaPay launch email", "email-manager", "claude_chat", "queued", 0.2, "email", 2),
        ("Write landing page copy: PulsePoint", "content-writer", "claude_chat", "queued", 0.1, "content", 4),
        ("Generate social media calendar", "social-media", "claude_chat", "queued", 0.05, "social", 5),
        ("Failed: Birch & Stone webhook", "content-writer", "webhook", "failed", 2, "content", 5),
        ("Retry: Broken API integration", "analytics", "script", "failed", 10, None, 1),
    ]

    for desc, agent, action_type, status, hours_ago, ckey, prio in queue_jobs:
        queued = now - timedelta(hours=hours_ago)
        started = queued + timedelta(seconds=random.randint(5, 120)) if status != "queued" else None
        completed = None
        error = None
        if status == "completed" and started:
            completed = started + timedelta(seconds=random.randint(30, 600))
        if status == "failed" and started:
            completed = started + timedelta(seconds=random.randint(5, 30))
            error = "Upstream API returned 502 Bad Gateway" if "webhook" in action_type else "Script exited with code 1"
        db.execute(
            "INSERT INTO job_queue (event_id, source, priority, concurrency_key, action_type, "
            "action_config, status, worker_id, queued_at, started_at, completed_at, result, error) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (None, agent, prio, ckey, action_type,
             json.dumps({"prompt": desc}), status,
             f"worker-{random.randint(1,3)}" if status in ("running", "completed", "failed") else None,
             iso(queued),
             iso(started) if started else None,
             iso(completed) if completed else None,
             "ok" if status == "completed" else None,
             error),
        )

    # =========================================================================
    # BUS EVENTS — 20 varied event bus entries
    # =========================================================================
    bus_types = [
        ("agent.started", "director", {"agent": "director", "reason": "workspace_init"}),
        ("agent.started", "content-writer", {"agent": "content-writer", "parent": "director"}),
        ("agent.started", "email-manager", {"agent": "email-manager", "parent": "director"}),
        ("agent.started", "social-media", {"agent": "social-media", "parent": "director"}),
        ("agent.started", "analytics", {"agent": "analytics", "parent": "director"}),
        ("job.completed", "email-manager", {"job_id": 1, "action": "Generate weekly email report", "duration_ms": 4200}),
        ("job.completed", "social-media", {"job_id": 2, "action": "Draft Instagram captions", "duration_ms": 3100}),
        ("job.completed", "analytics", {"job_id": 3, "action": "Compile Q1 ROI report", "duration_ms": 8500}),
        ("job.failed", "content-writer", {"job_id": 11, "error": "Upstream API 502", "retries": 3}),
        ("job.started", "analytics", {"job_id": 6, "action": "Analyze VeloCity ad spend"}),
        ("job.started", "social-media", {"job_id": 7, "action": "Schedule LinkedIn posts"}),
        ("event.fired", "analytics", {"event": "Weekly Analytics Report", "trigger": "cron"}),
        ("event.fired", "email-manager", {"event": "Email Drip: NovaPay Onboard", "trigger": "cron"}),
        ("event.fired", "social-media", {"event": "Social Post: Greenleaf Spring", "trigger": "cron"}),
        ("event.error", "email-manager", {"event": "Failed: Broken Webhook", "error": "Connection refused"}),
        ("chat.started", "director", {"session": "demo-session-1", "user": "admin"}),
        ("chat.started", "content-writer", {"session": "demo-session-2", "user": "admin"}),
        ("chat.message", "director", {"session": "demo-session-1", "role": "user", "length": 42}),
        ("usage.threshold", "content-writer", {"daily_cost": 0.08, "threshold": 0.10, "pct": 80}),
        ("system.health", "gateway", {"uptime_s": 259200, "db_size_mb": 2.4, "active_workers": 3}),
    ]

    for i, (btype, source, data) in enumerate(bus_types):
        created = now - timedelta(hours=i * 1.5, minutes=random.randint(0, 30))
        db.execute(
            "INSERT INTO bus_events (type, source, data, created_at) VALUES (?, ?, ?, ?)",
            (btype, source, json.dumps(data), iso(created)),
        )

    # =========================================================================
    # CHAT SESSIONS — 5 sessions across different agents with varied lengths
    # =========================================================================

    # Session 1: Director — campaign status discussion
    s1 = uid()
    s1_start = now - timedelta(hours=3)
    db.execute(
        "INSERT INTO chat_sessions (id, agent, workspace, started_at, last_message_at, status) "
        "VALUES (?, 'director', 'BrightWave Digital', ?, ?, 'active')",
        (s1, iso(s1_start), iso(s1_start + timedelta(minutes=12))),
    )
    for i, (role, content) in enumerate([
        ("user", "What's the status of our running campaigns?"),
        ("assistant", "We currently have 3 active campaigns running:\n\n1. **Spring Product Launch** for Greenleaf Organics — Email + Social, $4,200 budget\n2. **Brand Awareness Q2** for VeloCity Bikes — Paid Social + Blog, $12,000 budget\n3. **Loyalty Program Re-engagement** for VeloCity Bikes — Email, $2,400 budget\n\nAll three are on track. The Spring Product Launch has a 34% email open rate, above our 30% target."),
        ("user", "Great. Can you ask the analytics agent to prepare a mid-month report?"),
        ("assistant", "I've delegated the mid-month report task to the Analytics Agent. It will compile performance data across all active campaigns and have the report ready within the hour."),
        ("user", "Also, what's happening with PulsePoint Health? They're still onboarding right?"),
        ("assistant", "Correct — PulsePoint Health is still in the onboarding phase. Here's where we stand:\n\n- **Brand guidelines**: Received and reviewed\n- **Email templates**: Being designed by the email manager\n- **Social accounts**: Access pending from their IT team\n- **First campaign**: 'Patient Portal Announcement' is in review, targeting a May 1st launch\n\nElena Vasquez (VP Marketing) and James Wright (Content Strategist) are our primary contacts there."),
    ]):
        db.execute(
            "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (s1, role, content, iso(s1_start + timedelta(minutes=i * 2))),
        )

    # Session 2: Content Writer — subject lines
    s2 = uid()
    s2_start = now - timedelta(hours=1, minutes=30)
    db.execute(
        "INSERT INTO chat_sessions (id, agent, workspace, started_at, last_message_at, status) "
        "VALUES (?, 'content-writer', 'BrightWave Digital', ?, ?, 'active')",
        (s2, iso(s2_start), iso(s2_start + timedelta(minutes=8))),
    )
    for i, (role, content) in enumerate([
        ("user", "Write 3 subject line options for the NovaPay app launch email"),
        ("assistant", "Here are 3 subject line options for the NovaPay app launch:\n\n1. \"Your money just got smarter — NovaPay is here\"\n2. \"Meet NovaPay: Fast payments, zero hassle\"\n3. \"We built the payment app you've been waiting for\"\n\nOption 1 leans into curiosity, option 2 is benefit-driven, and option 3 uses anticipation. Want me to create A/B test variants for any of these?"),
        ("user", "Give me 2 A/B variants for option 1"),
        ("assistant", "Here are 2 A/B variants for \"Your money just got smarter — NovaPay is here\":\n\n**Variant A** (shorter, punchier): \"Smarter payments start now — meet NovaPay\"\n**Variant B** (question hook): \"Ready for smarter money? NovaPay just launched\"\n\nI'd recommend testing Variant A against the original — it keeps the 'smart' angle but leads with the action."),
    ]):
        db.execute(
            "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (s2, role, content, iso(s2_start + timedelta(minutes=i * 2))),
        )

    # Session 3: Email Manager — drip campaign design
    s3 = uid()
    s3_start = now - timedelta(hours=5)
    db.execute(
        "INSERT INTO chat_sessions (id, agent, workspace, started_at, last_message_at, status) "
        "VALUES (?, 'email-manager', 'BrightWave Digital', ?, ?, 'active')",
        (s3, iso(s3_start), iso(s3_start + timedelta(minutes=15))),
    )
    for i, (role, content) in enumerate([
        ("user", "Design a 5-email drip sequence for NovaPay's app launch"),
        ("assistant", "Here's a 5-email drip sequence for the NovaPay app launch:\n\n**Email 1 (Day 0)** — Welcome & Download\nSubject: \"Welcome to NovaPay — let's get you set up\"\nGoal: Drive app install, link to App Store / Google Play\n\n**Email 2 (Day 2)** — First Transaction\nSubject: \"Send your first payment in 30 seconds\"\nGoal: Activate first use, short tutorial\n\n**Email 3 (Day 5)** — Feature Highlight\nSubject: \"Did you know? Split bills instantly with NovaPay\"\nGoal: Showcase secondary features\n\n**Email 4 (Day 10)** — Social Proof\nSubject: \"Join 10,000+ people managing money smarter\"\nGoal: Build trust, share testimonials\n\n**Email 5 (Day 14)** — Referral Offer\nSubject: \"Give $10, get $10 — share NovaPay with friends\"\nGoal: Referral program activation\n\nWant me to draft the full copy for any of these?"),
        ("user", "Draft Email 1 in full"),
        ("assistant", "Here's the full draft for Email 1:\n\n---\n\n**Subject:** Welcome to NovaPay — let's get you set up\n**Preview text:** Your smarter payment app is ready.\n\nHi {{first_name}},\n\nWelcome to NovaPay! We're excited to have you.\n\nGetting started takes less than 2 minutes:\n\n1. **Download the app** → [App Store] | [Google Play]\n2. **Verify your identity** — just a quick selfie + ID\n3. **Link your bank** — we support 3,000+ institutions\n\nOnce you're set up, you can send money, split bills, and track spending — all in one place.\n\nNeed help? Reply to this email or chat with us in-app.\n\nWelcome aboard,\nThe NovaPay Team\n\n---\n\nShall I also draft Email 2?"),
    ]):
        db.execute(
            "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (s3, role, content, iso(s3_start + timedelta(minutes=i * 4))),
        )

    # Session 4: Social Media — content calendar
    s4 = uid()
    s4_start = now - timedelta(hours=8)
    db.execute(
        "INSERT INTO chat_sessions (id, agent, workspace, started_at, last_message_at, status) "
        "VALUES (?, 'social-media', 'BrightWave Digital', ?, ?, 'active')",
        (s4, iso(s4_start), iso(s4_start + timedelta(minutes=6))),
    )
    for i, (role, content) in enumerate([
        ("user", "Plan next week's social posts for Greenleaf Organics"),
        ("assistant", "Here's the Greenleaf Organics social calendar for next week:\n\n**Monday** — Instagram Reel: \"Farm to table in 3 steps\" (behind-the-scenes at the organic farm)\n**Tuesday** — LinkedIn Article share: \"Why Organic Sourcing Matters in 2025\"\n**Wednesday** — Instagram Story: Customer spotlight + recipe using Greenleaf products\n**Thursday** — X/Twitter Thread: \"5 myths about organic food, debunked\"\n**Friday** — Instagram Carousel: Weekend recipe ideas featuring spring produce\n**Saturday** — Facebook Event: Upcoming farmers market appearance\n\nAll posts align with the Spring Product Launch campaign. Want me to draft captions for any of these?"),
    ]):
        db.execute(
            "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (s4, role, content, iso(s4_start + timedelta(minutes=i * 3))),
        )

    # Session 5: Analytics — closed/completed session
    s5 = uid()
    s5_start = now - timedelta(days=2)
    db.execute(
        "INSERT INTO chat_sessions (id, agent, workspace, started_at, last_message_at, status) "
        "VALUES (?, 'analytics', 'BrightWave Digital', ?, ?, 'closed')",
        (s5, iso(s5_start), iso(s5_start + timedelta(minutes=10))),
    )
    for i, (role, content) in enumerate([
        ("user", "What's the ROI on the VeloCity Brand Awareness campaign so far?"),
        ("assistant", "Here's the VeloCity Brand Awareness Q2 campaign performance to date:\n\n| Metric | Value |\n|---|---|\n| Budget spent | $7,240 / $12,000 (60%) |\n| Impressions | 284,000 |\n| Clicks | 8,520 (3.0% CTR) |\n| Conversions | 342 |\n| Cost per acquisition | $21.17 |\n| Revenue attributed | $18,400 |\n| **ROI** | **154%** |\n\nThe campaign is performing well above the 100% ROI target. Paid social is the strongest channel (68% of conversions), while the blog content is driving organic traffic that converts at a lower CPA ($14.80).\n\nRecommendation: Reallocate $1,500 from underperforming Facebook ads to LinkedIn, which has a 2x higher conversion rate for this audience."),
        ("user", "Good analysis. Proceed with the reallocation recommendation."),
        ("assistant", "I've noted the budget reallocation. I'll coordinate with the Director to update the campaign config:\n\n- Facebook Ads: -$1,500 (from $4,000 to $2,500)\n- LinkedIn Ads: +$1,500 (from $3,000 to $4,500)\n\nThe change will take effect at the start of next week's ad cycle. I'll track the impact and report back in the next weekly analytics summary."),
    ]):
        db.execute(
            "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (s5, role, content, iso(s5_start + timedelta(minutes=i * 3))),
        )

    db.commit()
    db.close()
    print(f"Demo data seeded successfully:")
    print(f"  - {len(usage_rows)} token_usage rows (5 agents, 3 models, 14-day spread)")
    print(f"  - {len(event_data)} events (active/paused/failed/expired)")
    print(f"  - ~15 event_runs with success/error results")
    print(f"  - {len(queue_jobs)} queue jobs (queued/running/completed/failed)")
    print(f"  - {len(bus_types)} bus_events (agent/job/event/chat/system types)")
    print(f"  - 5 chat sessions across all agents (active + closed)")


if __name__ == "__main__":
    main()
