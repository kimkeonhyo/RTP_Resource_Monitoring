import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_: NextRequest, { params }: Params) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  await initDb();
  const pool = getPool();

  const { rows: complainRows } = await pool.query(
    `SELECT * FROM complaints WHERE id = $1`,
    [numId]
  );
  if (complainRows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { rows: fileRows } = await pool.query(
    `SELECT * FROM complaint_files WHERE complaint_id = $1 ORDER BY id ASC`,
    [numId]
  );

  return NextResponse.json({ complaint: complainRows[0], files: fileRows });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  await initDb();
  const pool = getPool();

  const body = await req.json() as Record<string, string | null>;

  // Build dynamic SET clause from provided fields only
  const allowedFields = [
    "customer_name", "applicant_name", "email", "phone", "job_title",
    "reporter", "assignee", "title", "status",
    "received_at", "resolved_at", "phenomenon", "action_method", "action_result",
    "response_status", "category", "priority",
  ];

  const updates: string[] = [];
  const values: (string | null)[] = [];
  let idx = 1;

  for (const field of allowedFields) {
    if (field in body) {
      updates.push(`${field} = $${idx}`);
      values.push(body[field]);
      idx++;
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  updates.push(`updated_at = $${idx}`);
  values.push(new Date().toISOString());
  idx++;
  values.push(String(numId));

  const { rows } = await pool.query(
    `UPDATE complaints SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ complaint: rows[0] });
}

export async function DELETE(_: NextRequest, { params }: Params) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  await initDb();
  const pool = getPool();

  // Also delete files from disk
  const { rows: fileRows } = await pool.query(
    `SELECT id, file_name FROM complaint_files WHERE complaint_id = $1`,
    [numId]
  );

  const fs = await import("fs");
  const path = await import("path");
  const dir = path.join(process.cwd(), "data", "complaints", String(numId));

  for (const f of fileRows) {
    const filePath = path.join(dir, `${f.id}_${f.file_name}`);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(dir); } catch { /* ignore */ }

  const result = await pool.query(`DELETE FROM complaints WHERE id = $1`, [numId]);
  if ((result.rowCount ?? 0) === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
