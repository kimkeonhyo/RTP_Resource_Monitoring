/**
 * GET /api/prompt-history/f1
 *
 * 전 고객사의 오토라벨링 탐지결과를 (고객사 × 프롬프트 버전)별로 집계하여
 * F1-Score 를 계산해 반환합니다. (온프레미스·원격 고객사 모두 포함)
 *
 *   F1 = 2·TP / (2·TP + FP + FN)
 *
 * 버전 귀속(적용일 기준 추정)은 prompt-performance 와 동일하게
 * prompt_history.applied_at 구간으로 각 탐지결과의 발생일을 매칭합니다.
 *
 * Response:
 *   {
 *     byCustomer: { [customerId]: { [version]: { tp, fp, fn, total, f1 } } },
 *     byVersion:  { [versionLower]: { tp, fp, fn, total, f1, customers } }   // 통합(다중 고객사 합산)
 *   }
 */
import { NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";

export const runtime = "nodejs";

interface Stat { tp: number; fp: number; fn: number; total: number; f1: number | null }

function f1(tp: number, fp: number, fn: number): number | null {
  const denom = 2 * tp + fp + fn;
  return denom > 0 ? (2 * tp) / denom : null;
}

export async function GET() {
  try {
    await initDb();
    const pool = getPool();

    const { rows } = await pool.query<{
      customer_id: string; version: string;
      tp: string; fp: string; fn: string;
    }>(
      `WITH ver AS (
         SELECT
           customer_id,
           version,
           LEFT(COALESCE(NULLIF(applied_at, ''), registered_at), 10)::date AS start_d,
           LEAD(LEFT(COALESCE(NULLIF(applied_at, ''), registered_at), 10)::date)
             OVER (PARTITION BY customer_id
                   ORDER BY LEFT(COALESCE(NULLIF(applied_at, ''), registered_at), 10)::date) AS next_d
         FROM prompt_history
         WHERE version IS NOT NULL
       ),
       dated AS (
         SELECT
           dr.customer_id,
           dr.result,
           CASE
             WHEN dr.event_time IS NOT NULL AND dr.file_name ~ '^\\d+$'
               THEN ((dr.event_time::timestamp AT TIME ZONE 'UTC')
                       AT TIME ZONE COALESCE(c.timezone, 'Asia/Seoul'))::date
             WHEN dr.event_time IS NOT NULL
               THEN dr.event_time::timestamp::date
             WHEN dr.file_name ~ '_\\d{8}_\\d{6}$'
               THEN TO_DATE((regexp_match(dr.file_name, '_(\\d{8})_\\d{6}$'))[1], 'YYYYMMDD')
             ELSE NULL
           END AS eff_d
         FROM detection_results dr
         JOIN customers c ON c.id = dr.customer_id
         WHERE dr.result IS NOT NULL
       ),
       attributed AS (
         SELECT
           d.customer_id,
           d.result,
           (
             SELECT v.version FROM ver v
             WHERE v.customer_id = d.customer_id
               AND d.eff_d >= v.start_d AND (v.next_d IS NULL OR d.eff_d < v.next_d)
             ORDER BY v.start_d DESC
             LIMIT 1
           ) AS version
         FROM dated d
         WHERE d.eff_d IS NOT NULL
       )
       SELECT
         customer_id,
         version,
         COUNT(*) FILTER (WHERE result = 'TP') AS tp,
         COUNT(*) FILTER (WHERE result = 'FP') AS fp,
         COUNT(*) FILTER (WHERE result = 'FN') AS fn
       FROM attributed
       WHERE version IS NOT NULL
       GROUP BY customer_id, version`,
    );

    const byCustomer: Record<string, Record<string, Stat>> = {};
    // 통합용 누적 (versionLower → 합계 + 고객사 set)
    const verAcc: Record<string, { tp: number; fp: number; fn: number; custs: Set<string> }> = {};

    for (const r of rows) {
      const tp = Number(r.tp), fp = Number(r.fp), fn = Number(r.fn);
      const total = tp + fp + fn;
      if (total === 0) continue;

      // 고객사별
      (byCustomer[r.customer_id] ??= {})[r.version] = { tp, fp, fn, total, f1: f1(tp, fp, fn) };

      // 통합 (버전 소문자 기준)
      const key = r.version.toLowerCase();
      const acc = (verAcc[key] ??= { tp: 0, fp: 0, fn: 0, custs: new Set() });
      acc.tp += tp; acc.fp += fp; acc.fn += fn; acc.custs.add(r.customer_id);
    }

    const byVersion: Record<string, Stat & { customers: number }> = {};
    for (const [key, a] of Object.entries(verAcc)) {
      byVersion[key] = {
        tp: a.tp, fp: a.fp, fn: a.fn, total: a.tp + a.fp + a.fn,
        f1: f1(a.tp, a.fp, a.fn), customers: a.custs.size,
      };
    }

    return NextResponse.json({ byCustomer, byVersion });
  } catch (e) {
    console.error("[prompt-history/f1]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
