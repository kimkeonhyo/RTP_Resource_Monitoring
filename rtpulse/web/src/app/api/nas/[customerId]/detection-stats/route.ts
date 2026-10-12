/**
 * GET  /api/nas/{customerId}/detection-stats  — 전체 요약 (기존 호환)
 * POST /api/nas/{customerId}/detection-stats  — 기간·groupBy 별 피벗 + 요약
 *
 * 탐지결과 메타데이터 우선순위:
 *   1. detection_results.event_name / camera_id / event_time 컬럼 (신규, 원격 포함)
 *   2. file_name 정규식 파싱 (레거시 NAS 데이터 fallback)
 *
 * event_time 타임존 처리:
 *   - 원격(file_name ~ '^\d+$'): UTC 저장 → AT TIME ZONE 으로 고객사 TZ 변환
 *   - NAS 백필 / NAS 수동: 로컬 시간 그대로 저장 → 변환 없음
 */
import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getPool, initDb } from "@/lib/db";

type Params = { params: Promise<{ customerId: string }> };
export const runtime = "nodejs";

type GroupBy = "day" | "week" | "month" | "camera" | "hour";

// ─── 레거시 NAS fallback 표현식 (file_name 파싱) ────────────────────────────
const FB_DATE   = `(regexp_match(file_name, '_(\\d{8})_\\d{6}$'))[1]`;
const FB_TIME   = `(regexp_match(file_name, '_\\d{8}_(\\d{6})$'))[1]`;
const FB_CAM    = `CASE WHEN file_name !~ '^\\d+$' THEN split_part(file_name, '_', 1) END`;
const FB_EVENT  = `(regexp_match(file_name, '^[^_]+_(.+)_\\d{8}_\\d{6}$'))[1]`;

/**
 * local_ts: 고객사 로컬 타임존 기준 timestamp
 *   원격 → UTC event_time 을 AT TIME ZONE 으로 변환
 *   NAS  → event_time 이미 로컬 → 그대로 캐스트
 *   레거시 NAS → event_time NULL → NULL (eff_date 는 raw_date 로 대체)
 */
function localTsExpr(tz: string): string {
  // tz 는 customer.timezone (IANA) — 관리자가 설정한 값이므로 SQL 인젝션 위험 없음
  return `CASE
    WHEN dr.event_time IS NOT NULL AND file_name ~ '^\\d+$'
      THEN (dr.event_time::TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE '${tz}'
    WHEN dr.event_time IS NOT NULL
      THEN dr.event_time::TIMESTAMP
    ELSE NULL
  END`;
}

/** 로컬 타임스탬프 기준 버킷 표현식 (local_ts 와 raw_date/raw_time 병용) */
function bucketExpr(groupBy: GroupBy): string {
  switch (groupBy) {
    case "day":
      return `CASE
        WHEN local_ts IS NOT NULL
          THEN TO_CHAR(local_ts, 'YYYY-MM-DD')
        ELSE CONCAT(SUBSTRING(raw_date,1,4),'-',SUBSTRING(raw_date,5,2),'-',SUBSTRING(raw_date,7,2))
      END`;
    case "week":
      return `CASE
        WHEN local_ts IS NOT NULL
          THEN TO_CHAR(DATE_TRUNC('week', local_ts::DATE), 'YYYY-MM-DD')
        ELSE TO_CHAR(DATE_TRUNC('week', TO_DATE(raw_date, 'YYYYMMDD')), 'YYYY-MM-DD')
      END`;
    case "month":
      return `CASE
        WHEN local_ts IS NOT NULL
          THEN TO_CHAR(DATE_TRUNC('month', local_ts::DATE), 'YYYY-MM-DD')
        ELSE CONCAT(SUBSTRING(raw_date,1,4),'-',SUBSTRING(raw_date,5,2),'-01')
      END`;
    case "camera":
      return `camera_id`;
    case "hour":
      return `CASE
        WHEN local_ts IS NOT NULL
          THEN LPAD(EXTRACT(HOUR FROM local_ts)::TEXT, 2, '0')
        ELSE LPAD(SUBSTRING(raw_time,1,2), 2, '0')
      END`;
  }
}

// ─── GET: 전체 요약 (기존 호환) ───────────────────────────────────────────────
export async function GET(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await initDb();
  const pool = getPool();

  const { rows } = await pool.query<{
    tp: string; fp: string; no_result: string;
    auto_labeled: string; manual_labeled: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE result = 'TP')                              AS tp,
       COUNT(*) FILTER (WHERE result = 'FP')                              AS fp,
       COUNT(*) FILTER (WHERE result IS NULL)                             AS no_result,
       COUNT(*) FILTER (WHERE result IS NOT NULL AND auto_labeled = TRUE)  AS auto_labeled,
       COUNT(*) FILTER (WHERE result IS NOT NULL AND auto_labeled = FALSE) AS manual_labeled
     FROM detection_results
     WHERE customer_id = $1`,
    [customerId],
  );

  const row           = rows[0];
  const tp            = Number(row.tp);
  const fp            = Number(row.fp);
  const noResult      = Number(row.no_result);
  const autoLabeled   = Number(row.auto_labeled);
  const manualLabeled = Number(row.manual_labeled);
  const labeled       = tp + fp;
  const total         = labeled + noResult;

  return NextResponse.json({ tp, fp, labeled, total, noResult, autoLabeled, manualLabeled });
}

// ─── POST: 기간·groupBy 별 피벗 + 기간 요약 ──────────────────────────────────
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await initDb();
  const pool = getPool();

  const { groupBy, from, to, timezone } = (await req.json()) as {
    groupBy:   GroupBy;
    from:      string;    // "YYYY-MM-DD"
    to:        string;    // "YYYY-MM-DD"
    timezone?: string;    // IANA 타임존 (없으면 customer.timezone 사용)
  };

  if (!["day", "week", "month", "camera", "hour"].includes(groupBy))
    return NextResponse.json({ error: "잘못된 groupBy 값입니다." }, { status: 400 });

  const tz      = customer.timezone ?? timezone ?? "Asia/Seoul";
  const fromRaw = from.replace(/-/g, "");   // YYYYMMDD
  const toRaw   = to.replace(/-/g, "");

  const ltExpr  = localTsExpr(tz);
  const bExpr   = bucketExpr(groupBy);

  // ── 피벗 쿼리 ─────────────────────────────────────────────────────────────
  //  enriched: 컬럼 우선 → fallback 정규식
  //  dated   : eff_date(YYYYMMDD) 계산 — 날짜 범위 필터에 사용
  const pivotResult = await pool.query<{
    bucket: string; event_name: string; tp: string; fp: string;
  }>(
    `WITH enriched AS (
       SELECT
         dr.result,
         COALESCE(dr.event_name, ${FB_EVENT})  AS event_name,
         COALESCE(dr.camera_id,  ${FB_CAM})    AS camera_id,
         ${ltExpr}                              AS local_ts,
         ${FB_DATE}                             AS raw_date,
         ${FB_TIME}                             AS raw_time
       FROM detection_results dr
       WHERE dr.customer_id = $1 AND dr.result IS NOT NULL
     ),
     dated AS (
       SELECT
         result, event_name, camera_id, local_ts, raw_date, raw_time,
         CASE
           WHEN local_ts IS NOT NULL THEN TO_CHAR(local_ts, 'YYYYMMDD')
           ELSE raw_date
         END AS eff_date
       FROM enriched
     )
     SELECT
       ${bExpr} AS bucket,
       event_name,
       COUNT(*) FILTER (WHERE result = 'TP') AS tp,
       COUNT(*) FILTER (WHERE result = 'FP') AS fp
     FROM dated
     WHERE event_name IS NOT NULL
       AND eff_date IS NOT NULL
       AND eff_date >= $2
       AND eff_date <= $3
     GROUP BY ${bExpr}, event_name
     ORDER BY 1 NULLS LAST, event_name`,
    [customerId, fromRaw, toRaw],
  );

  // ── 기간 요약 쿼리 ────────────────────────────────────────────────────────
  const summaryResult = await pool.query<{
    tp: string; fp: string; no_result: string;
    auto_labeled: string; manual_labeled: string;
  }>(
    `WITH enriched AS (
       SELECT
         dr.result,
         dr.auto_labeled,
         ${ltExpr}  AS local_ts,
         ${FB_DATE} AS raw_date
       FROM detection_results dr
       WHERE dr.customer_id = $1
     ),
     dated AS (
       SELECT
         result, auto_labeled,
         CASE
           WHEN local_ts IS NOT NULL THEN TO_CHAR(local_ts, 'YYYYMMDD')
           ELSE raw_date
         END AS eff_date
       FROM enriched
     )
     SELECT
       COUNT(*) FILTER (WHERE result = 'TP')                              AS tp,
       COUNT(*) FILTER (WHERE result = 'FP')                              AS fp,
       COUNT(*) FILTER (WHERE result IS NULL)                             AS no_result,
       COUNT(*) FILTER (WHERE result IS NOT NULL AND auto_labeled = TRUE)  AS auto_labeled,
       COUNT(*) FILTER (WHERE result IS NOT NULL AND auto_labeled = FALSE) AS manual_labeled
     FROM dated
     WHERE eff_date IS NOT NULL
       AND eff_date >= $2
       AND eff_date <= $3`,
    [customerId, fromRaw, toRaw],
  );

  const s             = summaryResult.rows[0];
  const tp            = Number(s.tp);
  const fp            = Number(s.fp);
  const noResult      = Number(s.no_result);
  const autoLabeled   = Number(s.auto_labeled);
  const manualLabeled = Number(s.manual_labeled);

  return NextResponse.json({
    rows: pivotResult.rows.map((r) => ({
      bucket:     r.bucket,
      event_name: r.event_name,
      tp:  Number(r.tp),
      fp:  Number(r.fp),
    })),
    summary: { tp, fp, labeled: tp + fp, noResult, autoLabeled, manualLabeled },
    groupBy,
    from,
    to,
  });
}
