/**
 * POST /api/nas/{customerId}/event-stats
 *
 * 온프레미스 고객사의 이벤트 통계 — event_registrations 테이블 기반
 * (DB 연결이 없는 온프레미스 고객사용)
 *
 * Request body:
 *   { from: "YYYY-MM-DD", to: "YYYY-MM-DD", groupBy: "day"|"week"|"month" }
 *
 * Response:
 *   { rows: { bucket: string; event_name: string; count: number }[] }
 */
import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getPool, initDb } from "@/lib/db";

type Params  = { params: Promise<{ customerId: string }> };
type GroupBy = "day" | "week" | "month";

export const runtime = "nodejs";

function bucketExpr(groupBy: GroupBy): string {
  // start_time 은 "YYYY-MM-DD HH:MM:SS" 형식 (로컬 시간, 온프레미스)
  switch (groupBy) {
    case "day":
      return `TO_CHAR(start_time::DATE, 'YYYY-MM-DD')`;
    case "week":
      return `TO_CHAR(DATE_TRUNC('week', start_time::DATE), 'YYYY-MM-DD')`;
    case "month":
      return `TO_CHAR(DATE_TRUNC('month', start_time::DATE), 'YYYY-MM-DD')`;
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await initDb();
  const pool = getPool();

  const { from, to, groupBy } = (await req.json()) as {
    from:    string;   // "YYYY-MM-DD"
    to:      string;   // "YYYY-MM-DD"
    groupBy: GroupBy;
  };

  if (!["day", "week", "month"].includes(groupBy))
    return NextResponse.json({ error: "잘못된 groupBy 값" }, { status: 400 });

  const bExpr = bucketExpr(groupBy);

  const { rows } = await pool.query<{ bucket: string; event_name: string; count: string }>(
    `SELECT
       ${bExpr}   AS bucket,
       event_name,
       COUNT(*)   AS count
     FROM event_registrations
     WHERE customer_id = $1
       AND event_name  IS NOT NULL
       AND start_time  IS NOT NULL
       AND start_time::DATE >= $2::DATE
       AND start_time::DATE <= $3::DATE
     GROUP BY ${bExpr}, event_name
     ORDER BY 1 NULLS LAST, event_name`,
    [customerId, from, to],
  );

  return NextResponse.json({
    rows: rows.map((r) => ({
      bucket:     r.bucket,
      event_name: r.event_name,
      count:      Number(r.count),
    })),
  });
}
