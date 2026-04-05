import { readdir, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

function getKnowledgePath(skillId: string): string {
  const [category, name] = skillId.split("/");
  return join(NEXAAS_ROOT, "knowledge", category, name);
}

// GET: List knowledge documents for this skill
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");
  const dir = getKnowledgePath(skillId);

  try {
    const files = await readdir(dir);
    const docs = files.map((f) => ({
      name: f,
      path: join(dir, f),
    }));
    return NextResponse.json({ ok: true, data: docs });
  } catch {
    return NextResponse.json({ ok: true, data: [] });
  }
}

// POST: Upload a knowledge document
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");
  const dir = getKnowledgePath(skillId);

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    await mkdir(dir, { recursive: true });

    const fileName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(join(dir, fileName), buffer);

    return NextResponse.json({ ok: true, message: `Uploaded ${fileName}` });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// DELETE: Remove a knowledge document
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");
  const { fileName } = await request.json();

  if (!fileName) {
    return NextResponse.json({ error: "fileName required" }, { status: 400 });
  }

  try {
    await unlink(join(getKnowledgePath(skillId), fileName));
    return NextResponse.json({ ok: true, message: `Deleted ${fileName}` });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
