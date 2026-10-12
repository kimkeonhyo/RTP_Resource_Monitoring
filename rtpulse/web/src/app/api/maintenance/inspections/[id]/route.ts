/**
 * GET    /api/maintenance/inspections/[id]
 * PATCH  /api/maintenance/inspections/[id]   — 필드 수정 + (선택) 다음 점검 자동 등록
 * DELETE /api/maintenance/inspections/[id]
 *
 * 점검 결과 등록(완료) 시 body.next = { inspection_name, cycle, scheduled_date? } 가 오면
 * 다음 점검 일정을 자동 생성하여 달력에 등록하고, 현재 점검의 next_id에 연결한다.
 *   - scheduled_date 미지정 시 완료일(또는 오늘) + cycle 로 자동 계산.
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";
import { nextDate, emptyReport, type Cycle } from "@/lib/maintenance";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const ALLOWED = [
  "customer_name", "shipment_id", "inspection_name", "cycle",
  "scheduled_date", "completed_date", "status", "inspector", "purpose", "report",
];

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  await initDb();
  const { rows } = await getPool().query(`SELECT * FROM maintenance_inspections WHERE id = $1`, [Number(id)]);
  if (rows.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ inspection: rows[0] });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const numId = Number(id);
  await initDb();
  const pool = getPool();

  const body = await req.json() as Record<string, unknown> & {
    next?: { inspection_name: string; cycle: Cycle; scheduled_date?: string };
  };

  // 동적 SET (허용 필드만)
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const f of ALLOWED) {
    if (f in body) {
      sets.push(`${f} = $${i++}`);
      vals.push(f === "report" ? JSON.stringify(body[f]) : body[f]);
    }
  }
  if (sets.length === 0 && !body.next) {
    return NextResponse.json({ error: "no fields" }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let current;
    if (sets.length > 0) {
      vals.push(new Date().toISOString()); // updated_at
      vals.push(numId);
      const { rows } = await client.query(
        `UPDATE maintenance_inspections SET ${sets.join(", ")}, updated_at = $${i++} WHERE id = $${i} RETURNING *`,
        vals,
      );
      if (rows.length === 0) { await client.query("ROLLBACK"); return NextResponse.json({ error: "not found" }, { status: 404 }); }
      current = rows[0];
    } else {
      const { rows } = await client.query(`SELECT * FROM maintenance_inspections WHERE id = $1`, [numId]);
      if (rows.length === 0) { await client.query("ROLLBACK"); return NextResponse.json({ error: "not found" }, { status: 404 }); }
      current = rows[0];
    }

    // 다음 점검 자동 등록
    let nextInspection = null;
    if (body.next?.inspection_name && body.next?.cycle) {
      const base = (current.completed_date as string) || (body.completed_date as string) || new Date().toISOString().slice(0, 10);
      const sched = body.next.scheduled_date || nextDate(String(base).slice(0, 10), body.next.cycle);
      const now = new Date().toISOString();
      const { rows: nx } = await client.query(
        `INSERT INTO maintenance_inspections
           (customer_name, shipment_id, inspection_name, cycle, scheduled_date,
            status, inspector, purpose, report, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'예정','','',$6,$7,$7)
         RETURNING *`,
        [
          current.customer_name, current.shipment_id,
          body.next.inspection_name, body.next.cycle, sched,
          JSON.stringify(emptyReport()), now,
        ],
      );
      nextInspection = nx[0];
      await client.query(
        `UPDATE maintenance_inspections SET next_id = $1, updated_at = $2 WHERE id = $3`,
        [nextInspection.id, now, numId],
      );
      current.next_id = nextInspection.id;
    }

    await client.query("COMMIT");
    return NextResponse.json({ inspection: current, next: nextInspection });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[maintenance/inspections PATCH]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  await initDb();
  const { rowCount } = await getPool().query(`DELETE FROM maintenance_inspections WHERE id = $1`, [Number(id)]);
  if (!rowCount) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
