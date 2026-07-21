# Nexaas Public Contracts

**Document status:** Generated inventory of the framework's queryable/config
surfaces (#258). Three registries live here: WAL ops, environment variables,
and the worker's HTTP routes. **Each is guarded by `tests/contract-docs.test.ts`
in CI** — adding a WAL op, env var, `/api` route, or palace wing to the code
without listing it here fails the PR. That guard is the point: these surfaces
are public contracts (the WAL is pitched as queryable; the env is the operator
interface; the routes are the cross-VPS protocol), so drift is a bug.

Update procedure: add the row when CI tells you to. Descriptions are yours to
write; the guard only checks presence.

---

## 1. WAL op registry

Every `op:` string the framework writes to `nexaas_memory.wal`. Query shape:
`SELECT * FROM nexaas_memory.wal WHERE op = '<op>' AND workspace = $1`.

### Skill execution
| op | written when |
|---|---|
| `shell_skill_completed` | shell executor finished, exit 0 |
| `shell_skill_failed` | shell executor failed / timed out |
| `ai_skill_skipped` | run skipped (preflight exit 1, or spend budget) |
| `ai_skill_preflight_passed` | preflight command exited 0 |
| `ai_skill_preflight_failed` | preflight command exited ≥2 |
| `ai_skill_verification` | post-run output verification result (#28) |
| `ai_skill_required_output_missing` | required output never produced (#180) |
| `skill_manifest_missing` | job referenced a manifest not on disk (#172) |
| `skill_unrecognized_execution_type` | manifest execution.type unroutable (#249) |
| `skill_trigger_http` | run started via POST /api/skills/trigger (#83) |
| `skill_version_pinned` | register-skill pinned a version |
| `job_completed` / `job_failed` | BullMQ job terminal states (pipeline path) |
| `subagent_completed` | subagent() run finished |

### Agentic loop
| op | written when |
|---|---|
| `agentic_turn` | every loop turn (tool calls, tokens, streaks) |
| `agentic_aborted` | guardrail stop (max_turns, spend_cap, repetition, …) |
| `agentic_truncated` | max_tokens cut a tool_use block mid-JSON (#26) |
| `ai_skill_aborted` / `ai_skill_completed` | run terminal record (model, cost, turns) |

### Model gateway
| op | written when |
|---|---|
| `model_call` | single-shot gateway execution (pipeline path) |
| `model_fallback` | chain advanced to a fallback model (#255) |
| `model_all_providers_failed` | every provider in the tier chain failed |
| `spend_budget_exceeded` | daily budget breach detected (#215) |
| `spend_budget_resumed` | queue resumed at local midnight |

### TAG / engine
| op | written when |
|---|---|
| `tag_routed` | output routed by TAG |
| `tag_unknown_action` | action kind not in manifest outputs → escalate |
| `tag_fallback_elevation` | non-Claude fallback elevated routing to approval |
| `tag_override_accepted` / `tag_override_denied` | workspace contract override evaluated |
| `action_auto_executed` / `action_deferred` / `action_escalated` / `action_flagged` | engine applied the routing decision |
| `output_produced` | framework__produce_output tool call (#45) |
| `output_staleness_detected` | expected output missing past deadline (#86) |

### Approvals / waitpoints
| op | written when |
|---|---|
| `approval_requested` | approval-request drawer emitted |
| `approval_decision_rejected` | decision outside the declared set |
| `approval_handler_missing` | decision had no handler skill bound |
| `approval_resolve_failed` | POST /api/approvals resolve failed (#205) |
| `approval_shadow_emit` | shadow-mode approval emitted (#124) |
| `waitpoint_created` / `waitpoint_resolved` | waitpoint lifecycle |
| `waitpoint_reminder_sent` | reminder_before fired |
| `waitpoint_timeout_escalated` / `waitpoint_timeout_cancelled` | expiry policy applied (#231) |
| `inbound_match_waitpoint_registered` / `inbound_match_waitpoint_resolved` / `inbound_match_waitpoint_cancelled` | inbound-match lifecycle (#66) |
| `inbound_match_resolve_failed` | matcher hit an error resolving |

### Notifications / PA
| op | written when |
|---|---|
| `notification_sent` / `notification_delivered` / `notification_failed` | dispatcher outcomes |
| `notification_delivered_via_pa` | delivery routed through a PA persona (#123) |
| `notification_skipped` / `notification_misconfigured` / `notification_reaped` | dispatcher edge outcomes |
| `pa_message_handled` | PA persona handled an inbound message |
| `pa_notify_received` | POST /api/pa/:user/notify accepted |
| `pa_delivery_dead` | delivery marker exhausted retries (#94) |
| `pa_delivery_reaped` | stale claimed marker reaped |
| `pa_rewire_error` / `pa_rewire_skipped` | PA rewire pass outcomes (#126) |
| `inbound_dispatched` / `inbound_dispatch_failed` / `inbound_no_subscriber` | inbound message routing |
| `inbound_drawer_relayed` | drawer relayed to a subscribed workspace |
| `batch_dispatched` / `batch_claim_failed` / `batch_consumer_failed` | batch dispatcher (#80) |

### Palace / library / GDPR
| op | written when |
|---|---|
| `palace_mcp_write` | palace_write MCP tool (canonical since #235) |
| `palace_seeded` | nexaas seed-palace ran |
| `cross_workspace_write` | drawer written into another workspace's scope |
| `library_contribute` / `library_promote` / `library_propagate` | library lifecycle |
| `proposal_accepted` | propagate proposal accepted |
| `gdpr_export` / `gdpr_delete` | GDPR actions (Art. 15/17) |

### Ops / lifecycle
| op | written when |
|---|---|
| `health_check` | health monitor tick summary |
| `alert_snoozed` | operator snoozed an alert class |
| `queue_paused` / `queue_resumed` | worker queue state changes (429 / budget) |
| `worker_crashed` / `worker_unhandled_rejection` | crash telemetry |
| `worker_shutdown_sweep` | graceful-shutdown sweep of in-flight runs (#86) |
| `scheduler_watchdog_overdue` | cron fired late / not at all (#86) |
| `silent_failure_alerted` | consecutive-failure threshold hit (#69) |
| `framework_upgraded` / `framework_rolled_back` | nexaas upgrade outcomes |
| `upgrade_conformance_failed` | post-upgrade gate failed → auto-rollback |
| `framework_consistency_warning` | doctor/startup consistency finding |
| `lock_acquired` / `lock_released` | concurrency-group mutex (#95) |
| `workspace_genesis` | chain root anchor written by init (linkage-only) |

---

## 2. Environment variables

Read via `process.env` in framework code. Core set documented in CLAUDE.md;
this is the complete inventory.

### Required
| var | purpose |
|---|---|
| `NEXAAS_WORKSPACE` | workspace id |
| `NEXAAS_ROOT` | framework install path (default /opt/nexaas) |
| `NEXAAS_WORKSPACE_ROOT` | workspace files path (.mcp.json, nexaas-skills/) |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `ANTHROPIC_API_KEY` | model access for AI skills |

### Worker / runtime
| var | default | purpose |
|---|---|---|
| `NEXAAS_WORKER_PORT` | 9090 | health + Bull Board + /api port |
| `NEXAAS_WORKER_BIND` | all interfaces | bind address (see security-surface.md) |
| `NEXAAS_WORKER_CONCURRENCY` | 5 | parallel job limit |
| `NEXAAS_ALLOW_DEV_LAUNCH` | unset | permit tsx (non-compiled) worker launch — dev/test only |
| `NEXAAS_CHANNEL` | unset | release channel the install tracks (stable/canary) |
| `NEXAAS_TIMEZONE` | UTC | cron fallback tz (after workspace config) |
| `NEXAAS_BACKUP_DIR` | /var/backups/nexaas | backup storage |
| `NEXAAS_PALACE_DB` | unset | palace DB name override (tooling) |
| `NEXAAS_WORKSPACE_MANIFEST_DIR` | /opt/nexmatic/workspaces | workspace manifest location |

### Model / agentic loop
| var | default | purpose |
|---|---|---|
| `ANTHROPIC_BASE_URL` | api.anthropic.com | SDK base URL (conformance mock uses this) |
| `OPENAI_API_KEY` | unset | fallback provider (single-shot path) |
| `VOYAGE_API_KEY` | unset | RAG embeddings |
| `NEXAAS_PROMPT_CACHE` | on | set off/false/0 to disable prompt caching |
| `NEXAAS_STREAM_IDLE_MS` | 180000 | streaming chunk-idle watchdog |
| `NEXAAS_CHUNK_IDLE_MS` | =STREAM_IDLE_MS | legacy alias, takes precedence when set |
| `NEXAAS_MCP_TOOL_TIMEOUT_MS` | 600000 | tools/call MCP timeout (handshakes stay 30s) |
| `NEXAAS_MCP_POOL_ENABLED` | unset | reuse MCP subprocesses across ai-skill runs (#63) |
| (registry-driven) | — | `base_url_env`/`auth_env` names in model-registry.yaml (e.g. `NEXAAS_LLM_BASE_URL`, `NEXAAS_LLM_TOKEN`) are read dynamically |

### PA service
| var | default | purpose |
|---|---|---|
| `NEXAAS_PA_TIMEOUT_MS` | 120000 | per-request handler timeout |
| `NEXAAS_PA_MAX_RETRIES` | 3 | delivery attempts before `dead` + ops_alert |
| `NEXAAS_PA_NORMAL_HOLD_MINUTES` | 15 | urgency:normal claimability hold |
| `NEXAAS_PA_LOW_RELEASE_HOUR` / `NEXAAS_PA_LOW_RELEASE_MINUTE` | 7 / 30 | urgency:low release time |

### Watchdogs / policy
| var | default | purpose |
|---|---|---|
| `NEXAAS_SCHEDULER_WATCHDOG_INTERVAL_MS` | (see task) | overdue-cron sweep cadence (#86) |
| `NEXAAS_SCHEDULER_WATCHDOG_GRACE_MULT` | (see task) | grace multiplier before alerting |
| `NEXAAS_SCHEDULER_WATCHDOG_CHANNEL_ROLE` | unset | alert channel role |
| `NEXAAS_OUTPUT_STALENESS_INTERVAL_MS` | (see task) | expected-output staleness sweep (#86) |
| `NEXAAS_OUTPUT_STALENESS_DEFAULT_ROLE` | unset | staleness alert channel role |
| `NEXAAS_SILENT_FAILURE_THRESHOLD` | 5 | consecutive failures before alert (#69) |
| `NEXAAS_SILENT_FAILURE_CHANNEL_ROLE` | unset | silent-failure alert channel (unset = off) |
| `NEXAAS_WAITPOINT_MAX_TIMEOUT_DAYS` | 1 | inbound-match timeout ceiling (#66) |
| `NEXAAS_WAL_RETENTION_DAYS` | unset (forever) | WAL retention policy |

### Security / fleet
| var | purpose |
|---|---|
| `NEXAAS_CROSS_VPS_BEARER_TOKEN` | bearer token for all /api/* routes (#217; unset = open, legacy posture) |
| `NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS` | rotation dual-accept window |
| `NEXAAS_FLEET_ENDPOINT` / `NEXAAS_FLEET_TOKEN` | fleet-heartbeat target (operator-managed only) |

### Notifications / integrations
| var | purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALERT_CHAT_ID` | Telegram alerts |
| `RESEND_API_KEY` / `OPS_ALERT_EMAIL` / `OPS_ALERT_FROM` | email alerts |
| `SENDGRID_API_KEY` / `POSTMARK_SERVER_TOKEN` | email-outbound providers |
| `EMAIL_OUTBOUND_PROVIDER` | provider selection for email-outbound MCP |
| `UNSUBSCRIBE_SECRET` | unsubscribe-link HMAC (#82) |
| `DASHBOARD_BASE_URL` / `NEXTAUTH_SECRET` / `AUTH_SECRET` | dashboard integration surfaces |
| `OPERATOR_NAME` / `OPERATOR_EMAIL` | operator identity for init/onboard |

(`HOME`, `PYTHONPATH`, `XDG_RUNTIME_DIR` are read for standard platform reasons, not framework config.)

---

## 3. Worker HTTP routes (`:9090`)

All `/api/*` routes require `Authorization: Bearer` when
`NEXAAS_CROSS_VPS_BEARER_TOKEN` is set (#217) — unset means open
(direct-adopter posture; see security-surface.md). `/health` and `/queues`
are always open (bind/firewall-gated instead).

| route | purpose |
|---|---|
| `GET /health` | worker liveness + state (open) |
| `GET /queues*` | Bull Board dashboard (open) |
| `POST /api/skills/trigger` | fire a registered skill by id (#83) |
| `POST /api/ingest` | generic inbound ingest |
| `POST /api/drawers/inbound` | cross-VPS drawer relay |
| `POST /api/waitpoints/inbound-match` | register an inbound-match waitpoint (#66) |
| `GET /api/waitpoints/inbound-match/patterns` | active matcher patterns |
| `GET /api/waitpoints/:id` | waitpoint state |
| `DELETE /api/waitpoints/:id` | cancel a waitpoint |
| `POST /api/approvals/:signal/resolve` | resolve an approval directly (#205) |
| `GET /api/approvals/by-message/:messageId` | look up approval by channel message |
| `POST /api/pa/message` | PA inbound message |
| `POST /api/pa/:user/notify` | PA-routed notification (#123) |
| `POST /api/addons/activate` | add-on activation hook |
