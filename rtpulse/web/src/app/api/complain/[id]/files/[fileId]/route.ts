import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fileId: string }> };

export async function GET(_: NextRequest, { params }: Params) {
  const { id, fileId } = await params;
  const numId = parseInt(id, 10);
  const numFileId = parseInt(fileId, 10);
  if (isNaN(numId) || isNaN(numFileId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  await initDb();
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT * FROM complaint_files WHERE id = $1 AND complaint_id = $2`,
    [numFileId, numId]
  );
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fileRecord = rows[0] as { id: number; file_name: string; file_type: string; file_size: number };

  const fs = await import("fs");
  const path = await import("path");
  const filePath = path.join(
    process.cwd(), "data", "complaints", String(numId),
    `${fileRecord.id}_${fileRecord.file_name}`
  );

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found on disk" }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);

  // Determine content disposition: inline for images/videos
  const isInline = fileRecord.file_type.startsWith("image/") || fileRecord.file_type.startsWith("video/");
  const disposition = isInline ? "inline" : `attachment; filename="${encodeURIComponent(fileRecord.file_name)}"`;

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": fileRecord.file_type,
      "Content-Disposition": disposition,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export async function DELETE(_: NextRequest, { params }: Params) {
  const { id, fileId } = await params;
  const numId = parseInt(id, 10);
  const numFileId = parseInt(fileId, 10);
  if (isNaN(numId) || isNaN(numFileId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  await initDb();
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT * FROM complaint_files WHERE id = $1 AND complaint_id = $2`,
    [numFileId, numId]
  );
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fileRecord = rows[0] as { id: number; file_name: string };

  // Delete from disk
  const fs = await import("fs");
  const path = await import("path");
  const filePath = path.join(
    process.cwd(), "data", "complaints", String(numId),
    `${fileRecord.id}_${fileRecord.file_name}`
  );
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }

  await pool.query(`DELETE FROM complaint_files WHERE id = $1`, [numFileId]);
  return NextResponse.json({ ok: true });
}
