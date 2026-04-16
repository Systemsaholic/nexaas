# Nexaas

Framework for context-aware AI execution. The Four Pillars (CAG, RAG, TAG, Contracts) running over a MemPalace-derived palace substrate, with BullMQ execution, pgvector retrieval, ed25519 operator signing, and a provider-agnostic model gateway.

## Architecture

```
packages/
├── palace/             @nexaas/palace — data model, palace API, WAL, signing, pgvector
├── runtime/            @nexaas/runtime — pillar pipeline, model gateway, BullMQ, sub-agents
├── factory/            @nexaas/factory — authoring primitives, library RAG, contribution pipeline
├── ops-console-core/   @nexaas/ops-console-core — console framework widgets
└── cli/                @nexaas/cli — verify-wal, validate-skill, install-agent, dry-run
```

## Documentation

- `docs/architecture.md` — Full framework architecture (start here)
- `docs/glossary.md` — Terminology reference
- `docs/README.md` — Doc index and reading order

## License

Proprietary — see [LICENSE](./LICENSE). Perpetual grants to named licensees.

## Consumers

- [Nexmatic](https://github.com/Systemsaholic/nexmatic) — AI business automation platform (primary consumer)
- Phoenix Voyages — travel industry automation
- Systemsaholic — internal operations
