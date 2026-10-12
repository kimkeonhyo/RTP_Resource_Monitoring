/**
 * GET  /api/maintenance/inspections?customer=&status=&from=&to=  — 점검 목록
 * POST /api/maintenance/inspections                              — 점검 일정 등록
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";
import { emptyReport } from "@/lib/maintenance";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await initDb();
  const pool = getPool();
  const sp = req.nextUrl.searchParams;

  const where: string[] = [];
  const vals: string[] = [];
  let i = 1;
  const customer = sp.get("customer");
  const status   = sp.get("status");
  const from     = sp.get("from");
  const to       = sp.get("to");
  if (customer) { where.push(`customer_name = $${i++}`); vals.push(customer); }
  if (status)   { where.push(`status = $${i++}`);        vals.push(status); }
  if (from)     { where.push(`scheduled_date >= $${i++}`); vals.push(from); }
  if (to)       { where.push(`scheduled_date <= $${i++}`); vals.push(to); }

  const { rows } = await pool.query(
    `SELECT * FROM maintenance_inspections
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY scheduled_date ASC, id ASC`,
    vals,
  );
  return NextResponse.json({ inspections: rows });
}

export async function POST(req: NextRequest) {
  await initDb();
  const pool = getPool();

  const body = await req.json() as {
    customer_name?: string;
    shipment_id?: string | null;
    inspection_name?: string;
    cycle?: string | null;
    scheduled_date?: string;
    inspector?: string;
    purpose?: string;
    report?: unknown;
    status?: string;
  };

  if (!body.customer_name?.trim()) return NextResponse.json({ error: "고객사명을 입력하세요." }, { status: 400 });
  if (!body.inspection_name?.trim()) return NextResponse.json({ error: "점검명을 선택하세요." }, { status: 400 });
  if (!body.scheduled_date) return NextResponse.json({ error: "점검 예정일을 입력하세요." }, { status: 400 });

  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO maintenance_inspections
       (customer_name, shipment_id, inspection_name, cycle, scheduled_date,
        status, inspector, purpose, report, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     RETURNING *`,
    [
      body.customer_name.trim(),
      body.shipment_id ?? null,
      body.inspection_name.trim(),
      body.cycle ?? null,
      body.scheduled_date,
      body.status ?? "예정",
      body.inspector ?? "",
      body.purpose ?? "",
      JSON.stringify(body.report ?? emptyReport()),
      now,
    ],
  );
  return NextResponse.json({ inspection: rows[0] }, { status: 201 });
}
