import { NextRequest, NextResponse } from "next/server";
import { getPrompts, updatePrompt, deletePrompt, filesDir } from "@/lib/prompts";
import path from "path";
import fs from "fs";

type Params = { params: Promise<{ customerId: string; promptId: string }> };

// GET: 파일 다운로드
export async function GET(_: NextRequest, { params }: Params) {
  const { customerId, promptId } = await params;
  const records = getPrompts(customerId);
  const record = records.find((r) => r.id === promptId);
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filePath = path.join(filesDir(customerId), record.fileName);
  if (!fs.existsSync(filePath))
    return NextResponse.json({ error: "File not found" }, { status: 404 });

  const buf = fs.readFileSync(filePath);
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${record.title}"`,
    },
  });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { customerId, promptId } = await params;
  const data = await req.json();
  const updated = updatePrompt(customerId, promptId, data);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_: NextRequest, { params }: Params) {
  const { customerId, promptId } = await params;
  const ok = deletePrompt(customerId, promptId);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
