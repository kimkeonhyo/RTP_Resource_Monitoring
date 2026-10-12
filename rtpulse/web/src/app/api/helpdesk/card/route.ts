import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Chatwoot 대시보드 앱(임베드)용 읽기 전용 카드 조회.
 *
 * GET /api/helpdesk/card?external_id=chatwoot:42&token=<HELPDESK_INGEST_TOKEN>
 *
 * 인증: 쿼리 token === env HELPDESK_INGEST_TOKEN (임베드 URL에 토큰을 실어 전달).
 *       proxy.ts matcher에서 제외되어 next-auth 세션 없이 iframe에서 접근 가능.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.HELPDESK_INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "disabled (no token configured)" }, { status: 503 });
  }
  const token = req.nextUrl.searchParams.get("token");
  if (token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const externalId = req.nextUrl.searchParams.get("external_id");
  if (!externalId) {
    return NextResponse.json({ error: "external_id required" }, { status: 400 });
  }

  await initDb();
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, customer_name, applicant_name, email, phone, job_title, title, status, category,
            phenomenon, action_method, action_result,
            received_at, resolved_at, created_at
       FROM complaints WHERE external_id = $1 LIMIT 1`,
    [externalId]
  );

  if (rows.length === 0) {
    return NextResponse.json({ found: false }, { status: 200 });
  }
  return NextResponse.json({ found: true, card: rows[0] }, { status: 200 });
}

/**
 * 임베드에서 카드 일부 필드 수정 (토큰 인증).
 * PATCH /api/helpdesk/card?token=...   body: { external_id, status?, title?, phenomenon?, action_method?, action_result? }
 */
export async function PATCH(req: NextRequest) {
  const expected = process.env.HELPDESK_INGEST_TOKEN;
  if (!expected) return NextResponse.json({ error: "disabled" }, { status: 503 });
  if (req.nextUrl.searchParams.get("token") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json() as Record<string, string>;
  const externalId = body.external_id?.trim();
  if (!externalId) return NextResponse.json({ error: "external_id required" }, { status: 400 });

  const allowed = ["status", "title", "phenomenon", "action_method", "action_result"];
  const sets: string[] = [];
  const vals: string[] = [];
  let i = 1;
  for (const f of allowed) {
    if (f in body) { sets.push(`${f} = $${i++}`); vals.push(body[f] ?? ""); }
  }
  if (sets.length === 0) return NextResponse.json({ error: "no fields" }, { status: 400 });

  await initDb();
  const pool = getPool();
  vals.push(new Date().toISOString());
  vals.push(externalId);
  const { rows } = await pool.query(
    `UPDATE complaints SET ${sets.join(", ")}, updated_at = $${i++} WHERE external_id = $${i} RETURNING *`,
    vals
  );
  if (rows.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, card: rows[0] }, { status: 200 });
}
