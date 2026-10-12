/**
 * POST /api/nas/{customerId}/prompt-performance
 *
 * 고객사의 오토라벨링 탐지결과(TP/FP/TN/FN)를 **적용 프롬프트 버전별**로 집계합니다.
 *
 * 프롬프트 버전 귀속(적용일 기준 추정):
 *   prompt_history 의 (version, applied_at) 타임라인으로 버전 구간을 만들고,
 *   각 탐지결과의 발생일(event_time → 로컬 날짜)이 속한 구간의 버전을 부여합니다.
 *   - applied_at 이 없으면 registered_at 으로 대체
 *   - 어떤 구간에도 속하지 않으면(최초 버전 이전 등) '미지정'
 *
 * event_time 타임존 처리는 detection-stats 와 동일:
 *   - 원격(file_name ~ '^\d+$'): UTC 저장 → 고객사 TZ 변환
 *   - NAS: 로컬 시간 그대로
 *
 * Response:
 *   {
 *     rows:     [{ bucket, prompt_version, tp, fp, tn, fn }],  // 그래프용 (기간/버킷별)
 *     versions: [{ prompt_version, applied_at, tp, fp, tn, fn, total }],  // 표용 (버전별 합계)
 *     groupBy, from, to
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getPool, initDb } from "@/lib/db";

type Params = { params: Promise<{ customerId: string }> };
export const runtime = "nodejs";

type GroupBy = "day" | "week" | "month";

// ─── 레거시 NAS fallback (file_name 파싱) ───────────────────────────────────
const FB_DATE = `(regexp_match(file_name, '_(\\d{8})_\\d{6}$'))[1]`;

/** 고객사 로컬 타임존 기준 timestamp (detection-stats 와 동일 로직) */
function localTsExpr(tz: string): string {
  return `CASE
    WHEN dr.event_time IS NOT NULL AND file_name ~ '^\\d+$'
      THEN (dr.event_time::TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE '${tz}'
    WHEN dr.event_time IS NOT NULL
      THEN dr.event_time::TIMESTAMP
    ELSE NULL
  END`;
}

/** eff_d(DATE) 기준 버킷 표현식 */
function bucketExpr(groupBy: GroupBy): string {
  switch (groupBy) {
    case "week":  return `TO_CHAR(DATE_TRUNC('week', eff_d), 'YYYY-MM-DD')`;
    case "month": return `TO_CHAR(DATE_TRUNC('month', eff_d), 'YYYY-MM-01')`;
    case "day":
    default:      return `TO_CHAR(eff_d, 'YYYY-MM-DD')`;
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await initDb();
  const pool = getPool();

  const { groupBy, from, to } = (await req.json()) as {
    groupBy: GroupBy;
    from:    string; // "YYYY-MM-DD"
    to:      string; // "YYYY-MM-DD"
  };

  if (!["day", "week", "month"].includes(groupBy))
    return NextResponse.json({ error: "잘못된 groupBy 값입니다." }, { status: 400 });

  const tz     = customer.timezone ?? "Asia/Seoul";
  const ltExpr = localTsExpr(tz);
  const bExpr  = bucketExpr(groupBy);

  /**
   * 공통 CTE:
   *  ver       — 고객사 프롬프트 버전 구간 (start_d ~ next_d)
   *  attributed — 각 탐지결과에 eff_d(로컬 발생일) + prompt_version 부여
   */
  const baseCte = `
    WITH ver AS (
      SELECT
        version,
        LEFT(COALESCE(NULLIF(applied_at, ''), registered_at), 10)::date AS start_d,
        LEAD(LEFT(COALESCE(NULLIF(applied_at, ''), registered_at), 10)::date)
          OVER (ORDER BY LEFT(COALESCE(NULLIF(applied_at, ''), registered_at), 10)::date) AS next_d
      FROM prompt_history
      WHERE customer_id = $1 AND version IS NOT NULL
    ),
    enriched AS (
      SELECT
        dr.result,
        ${ltExpr}  AS local_ts,
        ${FB_DATE} AS raw_date
      FROM detection_results dr
      WHERE dr.customer_id = $1 AND dr.result IS NOT NULL
    ),
    dated AS (
      SELECT
        result,
        CASE
          WHEN local_ts IS NOT NULL THEN local_ts::date
          WHEN raw_date IS NOT NULL THEN TO_DATE(raw_date, 'YYYYMMDD')
          ELSE NULL
        END AS eff_d
      FROM enriched
    ),
    attributed AS (
      SELECT
        d.result,
        d.eff_d,
        (
          SELECT v.version FROM ver v
          WHERE d.eff_d >= v.start_d AND (v.next_d IS NULL OR d.eff_d < v.next_d)
          ORDER BY v.start_d DESC
          LIMIT 1
        ) AS prompt_version
      FROM dated d
      WHERE d.eff_d IS NOT NULL
    )
  `;

  // ── 버킷별 × 버전별 (그래프용) ──────────────────────────────────────────────
  const pivot = await pool.query<{
    bucket: string; prompt_version: string | null;
    tp: string; fp: string; tn: string; fn: string;
  }>(
    `${baseCte}
     SELECT
       ${bExpr}                                AS bucket,
       COALESCE(prompt_version, '미지정')      AS prompt_version,
       COUNT(*) FILTER (WHERE result = 'TP')   AS tp,
       COUNT(*) FILTER (WHERE result = 'FP')   AS fp,
       COUNT(*) FILTER (WHERE result = 'TN')   AS tn,
       COUNT(*) FILTER (WHERE result = 'FN')   AS fn
     FROM attributed
     WHERE eff_d >= $2::date AND eff_d <= $3::date
     GROUP BY ${bExpr}, prompt_version
     ORDER BY 1, prompt_version`,
    [customerId, from, to],
  );

  // ── 버전별 합계 (표용) — 적용일 포함 ────────────────────────────────────────
  const versions = await pool.query<{
    prompt_version: string | null; applied_at: string | null;
    tp: string; fp: string; tn: string; fn: string; total: string;
  }>(
    `${baseCte}
     SELECT
       COALESCE(a.prompt_version, '미지정')      AS prompt_version,
       MIN(v.start_d)::text                       AS applied_at,
       COUNT(*) FILTER (WHERE a.result = 'TP')    AS tp,
       COUNT(*) FILTER (WHERE a.result = 'FP')    AS fp,
       COUNT(*) FILTER (WHERE a.result = 'TN')    AS tn,
       COUNT(*) FILTER (WHERE a.result = 'FN')    AS fn,
       COUNT(*)                                    AS total
     FROM attributed a
     LEFT JOIN ver v ON v.version = a.prompt_version
     WHERE a.eff_d >= $2::date AND a.eff_d <= $3::date
     GROUP BY a.prompt_version
     ORDER BY applied_at NULLS FIRST, prompt_version`,
    [customerId, from, to],
  );

  const num = (v: string) => Number(v);

  return NextResponse.json({
    rows: pivot.rows.map((r) => ({
      bucket:         r.bucket,
      prompt_version: r.prompt_version ?? "미지정",
      tp: num(r.tp), fp: num(r.fp), tn: num(r.tn), fn: num(r.fn),
    })),
    versions: versions.rows.map((r) => ({
      prompt_version: r.prompt_version ?? "미지정",
      applied_at:     r.applied_at,
      tp: num(r.tp), fp: num(r.fp), tn: num(r.tn), fn: num(r.fn),
      total: num(r.total),
    })),
    groupBy, from, to,
  });
}
