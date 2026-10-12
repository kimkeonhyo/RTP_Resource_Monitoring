import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  await initDb();
  const pool = getPool();

  // Check complaint exists
  const { rows: cr } = await pool.query(`SELECT id FROM complaints WHERE id = $1`, [numId]);
  if (cr.length === 0) return NextResponse.json({ error: "Complaint not found" }, { status: 404 });

  const formData = await req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const allowedTypes = [
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "video/mp4", "video/quicktime", "video/x-msvideo",
  ];
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json({ error: "허용되지 않는 파일 형식입니다." }, { status: 400 });
  }

  const sectionRaw = formData.get("section");
  const section = sectionRaw === "action_result" ? "action_result" : "bug";

  const now = new Date().toISOString();

  // Insert DB record first to get file id
  const { rows: fileRows } = await pool.query(
    `INSERT INTO complaint_files (complaint_id, file_name, file_type, file_size, uploaded_at, section)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [numId, file.name, file.type, file.size, now, section]
  );
  const fileRecord = fileRows[0] as { id: number; file_name: string; file_type: string; file_size: number; uploaded_at: string };

  // Save to disk
  const fs = await import("fs");
  const path = await import("path");
  const dir = path.join(process.cwd(), "data", "complaints", String(numId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const savePath = path.join(dir, `${fileRecord.id}_${file.name}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(savePath, buffer);

  return NextResponse.json({ file: fileRecord }, { status: 201 });
}
