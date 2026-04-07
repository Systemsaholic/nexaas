/**
 * Memory Seed Utility — bootstraps the knowledge graph from a seed.yaml file.
 *
 * Processes entities, relations, and facts using the internal store API.
 * Idempotent: uses entity upsert and content_hash dedup.
 */

import { readFileSync } from "fs";
import yaml from "js-yaml";
import { storeEvent, upsertEntity, addRelation, addFact } from "./store.js";

export interface SeedData {
  entities?: Array<{
    name: string;
    entity_type: string;
    aliases?: string[];
    metadata?: Record<string, unknown>;
  }>;
  relations?: Array<{
    from: string;
    relation_type: string;
    to: string;
    confidence?: number;
  }>;
  facts?: Array<{
    entity: string;
    key: string;
    value: string;
    confidence?: number;
  }>;
}

export async function seedFromFile(filePath: string): Promise<{
  entities: number; relations: number; facts: number;
}> {
  const raw = readFileSync(filePath, "utf-8");
  const data = yaml.load(raw) as SeedData;
  return seedMemory(data);
}

export async function seedMemory(data: SeedData): Promise<{
  entities: number; relations: number; facts: number;
}> {
  let entities = 0;
  let relations = 0;
  let facts = 0;

  // Entities first (relations and facts depend on them)
  for (const e of data.entities ?? []) {
    await upsertEntity(e.name, e.entity_type, e.aliases, undefined, e.metadata);
    entities++;
  }

  // Relations
  for (const r of data.relations ?? []) {
    try {
      await addRelation(r.from, r.relation_type, r.to, r.confidence);
      relations++;
    } catch {
      // Entity may not exist yet — skip silently
    }
  }

  // Facts
  for (const f of data.facts ?? []) {
    try {
      await addFact(f.entity, f.key, f.value, f.confidence);
      facts++;
    } catch {
      // Entity may not exist yet — skip silently
    }
  }

  // Store seed event for audit
  await storeEvent({
    agentId: "system",
    eventType: "context",
    content: `Memory seeded: ${entities} entities, ${relations} relations, ${facts} facts`,
    metadata: { source: "seed", entities, relations, facts },
  });

  return { entities, relations, facts };
}
