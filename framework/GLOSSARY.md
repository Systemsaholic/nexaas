# Glossary

| Term | Definition |
|---|---|
| **Workspace** | A user's deployment configuration directory. Contains `workspace.yaml`, agents, registries, skills, and memory files. Gitignored by default. |
| **Framework** | The shared, workspace-agnostic layer shipped with Nexaas. Contains default agents, skills, playbooks, and templates. |
| **Agent** | An AI actor defined by a `config.yaml` and optional `prompt.md`. Agents form a hierarchy via the `parent` field and are discovered from both framework and workspace. |
| **Skill** | A markdown file defining a reusable capability (e.g., `/health-check`). Discovered from `framework/skills/` and `workspace/skills/`. |
| **Registry** | A YAML data store with typed `fields` and `entries`. Used for structured business data (clients, invoices, etc.). |
| **Perspective** | A top-level navigation section in the dashboard (e.g., Operations, Marketing). Defined in `workspace.yaml`. |
| **Page** | A view within a perspective. Contains one or more components arranged in a layout. |
| **Component** | A dashboard widget type (e.g., `agent-tree`, `registry-table`, `stat-cards`, `event-timeline`). Placed on pages with a `span` (1–12 columns). |
| **Widget** | Synonym for component. |
| **Event** | A scheduled or triggered action stored in the database. Types: `cron`, `interval`, `once`, `webhook`. |
| **Job** | A queued unit of work created when an event fires. Executed by the worker pool. |
| **Worker** | A process in the worker pool that executes jobs (e.g., running a Claude Code chat session). |
| **Memory** | Persistent YAML files (`followups.yaml`, `checks.yaml`) in `workspace/memory/` that sync to the events table on engine start. |
| **Followup** | A one-time memory item. Synced as a `condition_type: once` event. |
| **Check** | A recurring memory item. Synced as a `condition_type: interval` event. |
| **Ops Monitor** | The built-in health monitoring system that tracks engine health, worker status, and database connectivity. |
