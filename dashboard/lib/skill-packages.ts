import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "js-yaml";

const exec = promisify(execFile);
const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
const SKILLS_DIR = join(NEXAAS_ROOT, "skills");

export interface SkillPackage {
  id: string;           // e.g., "msp/email-triage"
  category: string;     // e.g., "msp"
  name: string;         // e.g., "email-triage"
  version: string;
  type: "simple" | "agentic";
  status: string;
  description: string;
  files: string[];      // list of files in the package
  contract?: Record<string, unknown>;
}

export async function listSkillPackages(): Promise<SkillPackage[]> {
  const registryPath = join(SKILLS_DIR, "_registry.yaml");
  const raw = await readFile(registryPath, "utf-8");
  const registry = YAML.load(raw) as { skills: Array<Record<string, unknown>> };

  const packages: SkillPackage[] = [];

  for (const entry of registry.skills) {
    const id = entry.id as string;
    const [category, name] = id.split("/");
    const skillDir = join(SKILLS_DIR, category, name);

    let files: string[] = [];
    try {
      files = await listFilesRecursive(skillDir);
    } catch {
      // Skill dir may not exist yet (planned)
    }

    let contract: Record<string, unknown> | undefined;
    try {
      const contractRaw = await readFile(join(skillDir, "contract.yaml"), "utf-8");
      contract = YAML.load(contractRaw) as Record<string, unknown>;
    } catch {
      // No contract file yet
    }

    packages.push({
      id,
      category,
      name,
      version: (entry.version as string) ?? "0.0.0",
      type: (entry.type as "simple" | "agentic") ?? "simple",
      status: (entry.status as string) ?? "planned",
      description: (entry.description as string) ?? "",
      files,
      contract,
    });
  }

  return packages;
}

export async function getSkillPackage(skillId: string): Promise<SkillPackage & { fileContents: Record<string, string> }> {
  const [category, name] = skillId.split("/");
  const skillDir = join(SKILLS_DIR, category, name);

  const files = await listFilesRecursive(skillDir);
  const fileContents: Record<string, string> = {};

  for (const file of files) {
    try {
      fileContents[file] = await readFile(join(skillDir, file), "utf-8");
    } catch {
      fileContents[file] = "[binary or unreadable]";
    }
  }

  // Load from registry
  const registryPath = join(SKILLS_DIR, "_registry.yaml");
  const raw = await readFile(registryPath, "utf-8");
  const registry = YAML.load(raw) as { skills: Array<Record<string, unknown>> };
  const entry = registry.skills.find((s) => s.id === skillId) ?? {};

  let contract: Record<string, unknown> | undefined;
  if (fileContents["contract.yaml"]) {
    contract = YAML.load(fileContents["contract.yaml"]) as Record<string, unknown>;
  }

  return {
    id: skillId,
    category,
    name,
    version: (entry.version as string) ?? "0.0.0",
    type: (entry.type as "simple" | "agentic") ?? "simple",
    status: (entry.status as string) ?? "planned",
    description: (entry.description as string) ?? "",
    files,
    contract,
    fileContents,
  };
}

export async function updateSkillFile(skillId: string, fileName: string, content: string): Promise<void> {
  const [category, name] = skillId.split("/");
  const filePath = join(SKILLS_DIR, category, name, fileName);
  await writeFile(filePath, content, "utf-8");
}

export async function gitCommitSkill(skillId: string, fileName: string, message?: string): Promise<string> {
  const [category, name] = skillId.split("/");
  const filePath = join("skills", category, name, fileName);
  const commitMsg = message ?? `skill: update ${skillId} ${fileName}`;

  await exec("git", ["add", filePath], { cwd: NEXAAS_ROOT });

  try {
    const { stdout } = await exec(
      "git",
      ["-c", "user.name=Nexmatic", "-c", "user.email=ops@nexmatic.com", "commit", "-m", commitMsg],
      { cwd: NEXAAS_ROOT }
    );
    await exec("git", ["push"], { cwd: NEXAAS_ROOT });
    return stdout;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("nothing to commit") || msg.includes("no changes added")) {
      return "No changes to commit";
    }
    throw e;
  }
}

async function listFilesRecursive(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const subFiles = await listFilesRecursive(join(dir, entry.name), relPath);
      files.push(...subFiles);
    } else {
      files.push(relPath);
    }
  }

  return files;
}
