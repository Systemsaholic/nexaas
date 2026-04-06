/**
 * RAG Indexer — vectorizes documents for retrieval.
 *
 * Reads files from /opt/nexaas/knowledge/{skill}/ and indexes into Qdrant.
 * Also indexes identity docs and runbooks for client namespace.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { indexDocument, ensureCollection } from "./client.js";
import { logger } from "@trigger.dev/sdk/v3";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

/**
 * Index all knowledge files for a skill.
 */
export async function indexSkillKnowledge(
  workspaceId: string,
  skillId: string,
): Promise<number> {
  const [category, name] = skillId.split("/");
  const knowledgeDir = join(NEXAAS_ROOT, "knowledge", category, name);

  if (!existsSync(knowledgeDir)) return 0;

  const namespace = `${workspaceId}_knowledge`;
  await ensureCollection(namespace);

  const files = readdirSync(knowledgeDir);
  let totalChunks = 0;

  for (const file of files) {
    try {
      const content = readFileSync(join(knowledgeDir, file), "utf-8");
      const chunks = await indexDocument(namespace, `${skillId}/${file}`, content, {
        source: file,
        skillId,
        type: "knowledge",
      });
      totalChunks += chunks;
      logger.info(`Indexed ${chunks} chunks from ${file} into ${namespace}`);
    } catch (e) {
      logger.warn(`Failed to index ${file}: ${(e as Error).message}`);
    }
  }

  return totalChunks;
}

/**
 * Index all client identity docs for RAG retrieval.
 */
export async function indexClientIdentity(workspaceId: string): Promise<number> {
  const identityDir = join(NEXAAS_ROOT, "identity", workspaceId);
  if (!existsSync(identityDir)) return 0;

  const namespace = `${workspaceId}_knowledge`;
  await ensureCollection(namespace);

  const files = readdirSync(identityDir).filter((f) => f.endsWith(".md"));
  let totalChunks = 0;

  for (const file of files) {
    try {
      const content = readFileSync(join(identityDir, file), "utf-8");
      const chunks = await indexDocument(namespace, `identity/${file}`, content, {
        source: file,
        type: "identity",
      });
      totalChunks += chunks;
    } catch (e) {
      logger.warn(`Failed to index identity doc ${file}: ${(e as Error).message}`);
    }
  }

  return totalChunks;
}

/**
 * Index client runbooks.
 */
export async function indexClientRunbooks(workspaceId: string): Promise<number> {
  const runbooksDir = join(NEXAAS_ROOT, "runbooks");
  if (!existsSync(runbooksDir)) return 0;

  const namespace = `${workspaceId}_knowledge`;
  await ensureCollection(namespace);

  const files = readdirSync(runbooksDir).filter((f) => f.endsWith(".md"));
  let totalChunks = 0;

  for (const file of files) {
    try {
      const content = readFileSync(join(runbooksDir, file), "utf-8");
      const chunks = await indexDocument(namespace, `runbook/${file}`, content, {
        source: file,
        type: "runbook",
      });
      totalChunks += chunks;
    } catch (e) {
      logger.warn(`Failed to index runbook ${file}: ${(e as Error).message}`);
    }
  }

  return totalChunks;
}

/**
 * Full reindex for a workspace — identity + runbooks + all skill knowledge.
 */
export async function reindexWorkspace(workspaceId: string): Promise<{ totalChunks: number }> {
  let total = 0;

  total += await indexClientIdentity(workspaceId);
  total += await indexClientRunbooks(workspaceId);

  // Index all skill knowledge directories
  const knowledgeRoot = join(NEXAAS_ROOT, "knowledge");
  if (existsSync(knowledgeRoot)) {
    const categories = readdirSync(knowledgeRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const cat of categories) {
      const skills = readdirSync(join(knowledgeRoot, cat.name), { withFileTypes: true })
        .filter((d) => d.isDirectory());

      for (const skill of skills) {
        total += await indexSkillKnowledge(workspaceId, `${cat.name}/${skill.name}`);
      }
    }
  }

  logger.info(`Reindexed workspace ${workspaceId}: ${total} total chunks`);
  return { totalChunks: total };
}
