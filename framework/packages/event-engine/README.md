# Event Engine

The event-driven orchestration system that evaluates conditions and dispatches jobs to workers.

## How It Works

The engine runs a tick loop (default: every 30 seconds) that:

1. Queries all active events from the database
2. Evaluates each event's condition (cron expression, interval elapsed, one-time trigger, webhook match)
3. Enqueues matching events as jobs in the job queue
4. Workers pick up jobs and execute them (e.g., start a Claude Code chat session)

## Event Types

| Condition Type | Description | Example |
|---|---|---|
| `cron` | Cron expression schedule | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Seconds between runs | `3600` (hourly) |
| `once` | Single future execution | ISO timestamp |
| `webhook` | Triggered by HTTP POST | Incoming webhook match |

## Database Schema

Events are stored in the `events` table with fields: `id`, `type`, `condition_type`, `condition_expr`, `next_eval_at`, `action_type`, `action_config`, `status`, `agent`, `description`.

## API Endpoints

- `GET /api/events` — list all events
- `POST /api/events` — create an event
- `PATCH /api/events/{id}` — update an event
- `DELETE /api/events/{id}` — delete an event
- `POST /api/events/{id}/trigger` — manually trigger an event

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ENGINE_TICK_SECONDS` | `30` | Evaluation loop interval |
| `WORKER_POOL_SIZE` | `3` | Number of concurrent workers |
