-- Nexaas Memory System — nexaas_memory schema
-- Spec: Memory System v2.0, Sections 3.1–3.5
--
-- 5 tables: events (verbatim log), entities (KG nodes), relations (KG edges),
-- facts (entity attributes), agent_journal (per-task working memory)

CREATE SCHEMA IF NOT EXISTS nexaas_memory;

-- pg_trgm for fuzzy entity name matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 3.1 Events — Append-only verbatim record ───────────────────────────

CREATE TABLE IF NOT EXISTS nexaas_memory.events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL,
  trigger_task_id TEXT,
  event_type    TEXT NOT NULL,  -- decision | action | skill_run | human_approval | error | preference | context
  content       TEXT NOT NULL,
  content_hash  TEXT,
  metadata      JSONB DEFAULT '{}',
  parent_event_id UUID REFERENCES nexaas_memory.events(id),
  embedding_id  TEXT,
  schema_version TEXT NOT NULL DEFAULT '1.0',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_agent_id ON nexaas_memory.events (agent_id);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON nexaas_memory.events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON nexaas_memory.events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_content_hash ON nexaas_memory.events (content_hash);

-- ── 3.2 Entities — Knowledge Graph nodes ────────────────────────────────

CREATE TABLE IF NOT EXISTS nexaas_memory.entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  entity_type   TEXT NOT NULL,  -- client | project | system | person | concept | decision
  aliases       TEXT[] DEFAULT '{}',
  summary       TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type
  ON nexaas_memory.entities (LOWER(name), entity_type);

CREATE INDEX IF NOT EXISTS idx_entities_name_trgm
  ON nexaas_memory.entities USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_entities_aliases
  ON nexaas_memory.entities USING GIN (aliases);

-- ── 3.3 Relations — Knowledge Graph edges ───────────────────────────────

CREATE TABLE IF NOT EXISTS nexaas_memory.relations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity_id  UUID NOT NULL REFERENCES nexaas_memory.entities(id),
  to_entity_id    UUID NOT NULL REFERENCES nexaas_memory.entities(id),
  relation_type   TEXT NOT NULL,  -- uses | manages | decided_by | replaced_by | owns | works_at | has_role
  confidence      FLOAT DEFAULT 1.0,
  source_event_id UUID REFERENCES nexaas_memory.events(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relations_from ON nexaas_memory.relations (from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON nexaas_memory.relations (to_entity_id);

-- ── 3.4 Facts — Entity attribute store ──────────────────────────────────

CREATE TABLE IF NOT EXISTS nexaas_memory.facts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID NOT NULL REFERENCES nexaas_memory.entities(id),
  fact_key        TEXT NOT NULL,
  fact_value      TEXT NOT NULL,
  confidence      FLOAT DEFAULT 1.0,
  source_event_id UUID REFERENCES nexaas_memory.events(id),
  superseded_by   UUID REFERENCES nexaas_memory.facts(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON nexaas_memory.facts (entity_id, fact_key);

-- ── 3.5 Agent Journal — Per-task working memory ────────────────────────

CREATE TABLE IF NOT EXISTS nexaas_memory.agent_journal (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL,
  trigger_task_id TEXT NOT NULL,
  role            TEXT NOT NULL,  -- system | user | assistant
  content         TEXT NOT NULL,
  metadata        JSONB DEFAULT '{}',
  seq             INTEGER NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  flushed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_journal_task_seq
  ON nexaas_memory.agent_journal (trigger_task_id, seq);
