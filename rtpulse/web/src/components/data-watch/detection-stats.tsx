"use client";

import { Fragment, useState, useEffect, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { Customer } from "@/lib/types";

// ─── Timezone-aware date utils ────────────────────────────────────────────────
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date());
}
function nDaysAgoInTz(n: number, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(
    new Date(Date.now() - n * 86_400_000),
  );
}

type GroupBy = "day" | "week" | "month" | "camera" | "hour";

const GROUP_LABELS: Record<GroupBy, string> = {
  day: "일별", week: "주간", month: "월별", camera: "카메라별", hour: "시간별",
};

function presetRange(gb: GroupBy, tz: string): { from: string; to: string } {
  const today = todayInTz(tz);
  if (gb === "week")  return { from: nDaysAgoInTz(28,  tz), to: today };
  if (gb === "month") return { from: nDaysAgoInTz(180, tz), to: today };
  return { from: nDaysAgoInTz(7, tz), to: today };
}

function bucketLabel(groupBy: GroupBy, bucket: string): string {
  if (groupBy === "month")  return bucket.slice(0, 7);
  if (groupBy === "week")   return `${bucket.slice(5, 7)}/${bucket.slice(8, 10)}~`;
  if (groupBy === "camera") return `CAM ${bucket}`;
  if (groupBy === "hour")   return `${bucket}시`;
  return bucket.slice(5); // day → MM-DD
}

function bucketColHeader(groupBy: GroupBy): string {
  if (groupBy === "camera") return "카메라 ID";
  if (groupBy === "hour")   return "시간대";
  if (groupBy === "week")   return "주 시작일";
  if (groupBy === "month")  return "월";
  return "날짜";
}

// ─── 이벤트별 색상 팔레트 ─────────────────────────────────────────────────────
// TP 계열: 초록/청록 계열
const TP_COLORS = ["#34d399", "#22d3ee", "#a3e635", "#4ade80", "#2dd4bf", "#86efac"];
// FP 계열: 빨간/주황 계열 (이벤트 순서 동일)
const FP_COLORS = ["#f87171", "#fb923c", "#f472b6", "#fbbf24", "#e879f9", "#60a5fa"];

// ─── Types ────────────────────────────────────────────────────────────────────
interface PivotRow {
  bucket:     string;
  event_name: string;
  tp:         number;
  fp:         number;
}
interface Summary {
  tp:             number;
  fp:             number;
  labeled:        number;
  noResult:       number;
  autoLabeled:    number;
  manualLabeled:  number;
}
interface StatsData {
  rows:    PivotRow[];
  summary: Summary;
  groupBy: string;
  from:    string;
  to:      string;
}

interface Props { customer: Customer }

// ─── Custom Tooltip ───────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; fill: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  // payload 이름에서 "__tp" / "__fp" suffix 제거해 이벤트명 추출
  const tpItems = payload.filter((p) => p.name.endsWith("__tp") && p.value > 0);
  const fpItems = payload.filter((p) => p.name.endsWith("__fp") && p.value > 0);
  const totalTp = tpItems.reduce((s, p) => s + p.value, 0);
  const totalFp = fpItems.reduce((s, p) => s + p.value, 0);

  return (
    <div className="bg-panel border border-line2 rounded-xl p-3 text-xs shadow-xl min-w-[140px]">
      <p className="text-ink2 font-semibold mb-2">{label}</p>
      {tpItems.length > 0 && (
        <div className="mb-1.5">
          <p className="text-green-500 font-medium mb-0.5">TP {totalTp}건</p>
          {tpItems.map((p) => (
            <p key={p.name} className="text-faint pl-2">
              <span style={{ color: p.fill }}>■</span>{" "}
              {p.name.replace("__tp", "")} {p.value}
            </p>
          ))}
        </div>
      )}
      {fpItems.length > 0 && (
        <div>
          <p className="text-red-400 font-medium mb-0.5">FP {totalFp}건</p>
          {fpItems.map((p) => (
            <p key={p.name} className="text-faint pl-2">
              <span style={{ color: p.fill }}>■</span>{" "}
              {p.name.replace("__fp", "")} {p.value}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function DetectionStats({ customer }: Props) {
  const tz    = customer.timezone ?? "Asia/Seoul";
  const hasDb = !!(customer.dbPassword);

  const [groupBy,     setGroupBy]     = useState<GroupBy>("day");
  const [from,        setFrom]        = useState(() => nDaysAgoInTz(7, tz));
  const [to,          setTo]          = useState(() => todayInTz(tz));
  const [data,        setData]        = useState<StatsData | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [knownEvents, setKnownEvents] = useState<string[]>([]);

  // MySQL 이벤트 목록 로드 (원격 고객사) — 컬럼 누락 방지
  useEffect(() => {
    if (!hasDb) return;
    fetch(`/api/db/${customer.id}/crawl`)
      .then((r) => r.json())
      .then((d) => setKnownEvents(d.events ?? []))
      .catch(() => {});
  }, [customer.id, hasDb]);

  const fetchStats = useCallback(async (gb: GroupBy, f: string, t: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/nas/${customer.id}/detection-stats`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ groupBy: gb, from: f, to: t, timezone: tz }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "조회 실패"); setData(null); }
      else          { setData(json as StatsData); }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [customer.id, tz]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    fetchStats("day", nDaysAgoInTz(7, tz), todayInTz(tz));
  }, [customer.id]);

  function handleGroupByChange(gb: GroupBy) {
    setGroupBy(gb);
    const range = presetRange(gb, tz);
    setFrom(range.from);
    setTo(range.to);
    fetchStats(gb, range.from, range.to);
  }

  // ── Derived ──────────────────────────────────────────────────────────────────
  const rows    = data?.rows    ?? [];
  const summary = data?.summary ?? null;

  // 순서 보존 버킷 목록
  const buckets: string[] = [];
  const bucketsSet = new Set<string>();
  for (const r of rows) {
    if (!bucketsSet.has(r.bucket)) { buckets.push(r.bucket); bucketsSet.add(r.bucket); }
  }

  // 이벤트명 목록: 라벨링된 + MySQL 전체 병합 (정렬)
  const eventNames = [...new Set([
    ...rows.map((r) => r.event_name),
    ...knownEvents,
  ])].sort();

  // pivot map: bucket → event_name → {tp, fp}
  const pivotMap = new Map<string, Map<string, { tp: number; fp: number }>>();
  for (const r of rows) {
    if (!pivotMap.has(r.bucket)) pivotMap.set(r.bucket, new Map());
    pivotMap.get(r.bucket)!.set(r.event_name, { tp: r.tp, fp: r.fp });
  }

  // ── 차트 데이터 ───────────────────────────────────────────────────────────────
  // 이벤트별 TP / FP 스택 두 그룹 — stackId="tp" | stackId="fp"
  // key: "${eventName}__tp" / "${eventName}__fp"
  const chartData = buckets.map((bucket) => {
    const evMap = pivotMap.get(bucket) ?? new Map();
    const point: Record<string, string | number> = {
      label: bucketLabel(groupBy, bucket),
    };
    for (const ev of eventNames) {
      const cell = evMap.get(ev);
      point[`${ev}__tp`] = cell?.tp ?? 0;
      point[`${ev}__fp`] = cell?.fp ?? 0;
    }
    return point;
  });

  // X축 레이블 회전 (버킷 수 또는 보기 방식에 따라)
  const xAngle = (groupBy === "camera" || groupBy === "hour")
    ? 0
    : buckets.length > 6 ? -35 : buckets.length > 3 ? -20 : 0;
  const xHeight = Math.abs(xAngle) > 0 ? 50 : 28;

  const autoPct   = summary && summary.labeled > 0 ? Math.round(summary.autoLabeled   / summary.labeled * 100) : 0;
  const manualPct = summary && summary.labeled > 0 ? Math.round(summary.manualLabeled / summary.labeled * 100) : 0;
  const tpPct     = summary && summary.labeled > 0 ? Math.round(summary.tp            / summary.labeled * 100) : 0;
  const fpPct     = summary && summary.labeled > 0 ? Math.round(summary.fp            / summary.labeled * 100) : 0;

  return (
    <div className="border border-line rounded-xl overflow-hidden">

      {/* ── 필터 바 ── */}
      <div className="p-4 space-y-3 border-b border-line">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex rounded-lg overflow-hidden border border-line2 flex-wrap">
            {(["day", "week", "month", "camera", "hour"] as GroupBy[]).map((gb) => (
              <button
                key={gb}
                onClick={() => handleGroupByChange(gb)}
                className={`px-3 py-1.5 text-xs transition-colors ${
                  groupBy === gb
                    ? "bg-cyan-700 text-white"
                    : "bg-input text-muted hover:bg-gray-700"
                }`}
              >
                {GROUP_LABELS[gb]}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={dateCls} />
            <span className="text-faint text-xs">~</span>
            <input type="date" value={to}   onChange={(e) => setTo(e.target.value)}   className={dateCls} />
          </div>

          <button
            onClick={() => fetchStats(groupBy, from, to)}
            disabled={loading}
            className="px-4 py-1.5 text-xs bg-cyan-700 text-white rounded-lg hover:bg-cyan-600 disabled:opacity-40 font-medium"
          >
            {loading ? "조회 중…" : "조회"}
          </button>
        </div>
      </div>

      {/* ── 에러 ── */}
      {error && (
        <div className="p-4">
          <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</p>
        </div>
      )}

      {/* ── 로딩 ── */}
      {loading && (
        <div className="p-8 text-center">
          <p className="text-xs text-faint">조회 중...</p>
        </div>
      )}

      {/* ── 결과 ── */}
      {!loading && data && (
        <>
          {/* 요약 카드 */}
          {summary && summary.labeled > 0 && (
            <div className="p-4 border-b border-line">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <StatCard label="총 라벨링"   value={summary.labeled}        color="cyan"   />
                <StatCard label="TP"          value={summary.tp}             color="green"  pct={tpPct}     />
                <StatCard label="FP"          value={summary.fp}             color="red"    pct={fpPct}     />
                <StatCard label="자동 라벨링" value={summary.autoLabeled}    color="purple" pct={autoPct}   />
                <StatCard label="수동 라벨링" value={summary.manualLabeled}  color="amber"  pct={manualPct} />
              </div>
            </div>
          )}

          {/* ── 막대 그래프 ── */}
          {rows.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-xs text-faint">조회된 탐지결과 없음</p>
            </div>
          ) : (
            <>
              {/* 차트 */}
              <div className="p-4 border-b border-line">
                {/* 범례: TP / FP + 이벤트 색상 */}
                <div className="flex items-center gap-4 mb-3 flex-wrap">
                  <span className="text-[10px] text-faint font-medium">TP</span>
                  {eventNames.map((ev, i) => (
                    <span key={`tp-${ev}`} className="flex items-center gap-1 text-[10px] text-muted">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: TP_COLORS[i % TP_COLORS.length] }} />
                      {ev}
                    </span>
                  ))}
                  <span className="w-px h-3 bg-gray-700 mx-1" />
                  <span className="text-[10px] text-faint font-medium">FP</span>
                  {eventNames.map((ev, i) => (
                    <span key={`fp-${ev}`} className="flex items-center gap-1 text-[10px] text-muted">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: FP_COLORS[i % FP_COLORS.length] }} />
                      {ev}
                    </span>
                  ))}
                </div>

                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={chartData}
                    margin={{ top: 4, right: 12, left: -10, bottom: xHeight }}
                    barCategoryGap="28%"
                    barGap={4}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-line))" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "#6b7280", fontSize: 11 }}
                      angle={xAngle}
                      textAnchor={xAngle < 0 ? "end" : "middle"}
                      interval={0}
                      axisLine={{ stroke: "#374151" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#6b7280", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                      width={32}
                    />
                    <Tooltip
                      content={<ChartTooltip />}
                      cursor={{ fill: "rgba(255,255,255,0.04)" }}
                    />

                    {/* TP 스택 (stackId="tp") — 이벤트별 초록 계열 */}
                    {eventNames.map((ev, i) => (
                      <Bar
                        key={`${ev}__tp`}
                        dataKey={`${ev}__tp`}
                        stackId="tp"
                        fill={TP_COLORS[i % TP_COLORS.length]}
                        name={`${ev}__tp`}
                        radius={i === eventNames.length - 1 ? [3, 3, 0, 0] : undefined}
                        maxBarSize={52}
                        isAnimationActive={false}
                      />
                    ))}

                    {/* FP 스택 (stackId="fp") — 이벤트별 빨간 계열 */}
                    {eventNames.map((ev, i) => (
                      <Bar
                        key={`${ev}__fp`}
                        dataKey={`${ev}__fp`}
                        stackId="fp"
                        fill={FP_COLORS[i % FP_COLORS.length]}
                        name={`${ev}__fp`}
                        radius={i === eventNames.length - 1 ? [3, 3, 0, 0] : undefined}
                        maxBarSize={52}
                        isAnimationActive={false}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* 피벗 테이블 */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-line2 bg-panel/60 text-faint">
                      <th className="px-4 py-2 text-left font-medium whitespace-nowrap" rowSpan={2}>
                        {bucketColHeader(groupBy)}
                      </th>
                      {eventNames.map((ev) => (
                        <th
                          key={ev}
                          colSpan={2}
                          className="px-4 py-2 text-center font-medium whitespace-nowrap border-l border-line2"
                        >
                          {ev}
                        </th>
                      ))}
                      <th colSpan={2} className="px-4 py-2 text-center font-medium whitespace-nowrap border-l border-line2 text-muted">
                        합계
                      </th>
                    </tr>
                    <tr className="border-b border-line2 bg-panel/40">
                      {eventNames.map((ev) => (
                        <Fragment key={ev}>
                          <th className="px-3 py-1.5 text-center font-medium border-l border-line2 text-green-700 whitespace-nowrap">TP</th>
                          <th className="px-3 py-1.5 text-center font-medium text-red-700 whitespace-nowrap">FP</th>
                        </Fragment>
                      ))}
                      <th className="px-3 py-1.5 text-center font-medium border-l border-line2 text-green-700 whitespace-nowrap">TP</th>
                      <th className="px-3 py-1.5 text-center font-medium text-red-700 whitespace-nowrap">FP</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-line/50">
                    {buckets.map((bucket) => {
                      const evMap = pivotMap.get(bucket) ?? new Map();
                      const rowTp = eventNames.reduce((s, ev) => s + (evMap.get(ev)?.tp ?? 0), 0);
                      const rowFp = eventNames.reduce((s, ev) => s + (evMap.get(ev)?.fp ?? 0), 0);
                      return (
                        <tr key={bucket} className="hover:bg-input/20 transition-colors">
                          <td className="px-4 py-2 font-mono text-muted whitespace-nowrap">
                            {bucketLabel(groupBy, bucket)}
                          </td>
                          {eventNames.map((ev) => {
                            const cell = evMap.get(ev);
                            return (
                              <Fragment key={ev}>
                                <td className={`px-3 py-2 text-center font-mono tabular-nums border-l border-line ${cell?.tp ? "text-green-400" : "text-faint"}`}>
                                  {cell?.tp ? cell.tp : "—"}
                                </td>
                                <td className={`px-3 py-2 text-center font-mono tabular-nums ${cell?.fp ? "text-red-400" : "text-faint"}`}>
                                  {cell?.fp ? cell.fp : "—"}
                                </td>
                              </Fragment>
                            );
                          })}
                          <td className={`px-3 py-2 text-center font-mono font-semibold tabular-nums border-l border-line ${rowTp > 0 ? "text-green-400" : "text-faint"}`}>
                            {rowTp > 0 ? rowTp : "—"}
                          </td>
                          <td className={`px-3 py-2 text-center font-mono font-semibold tabular-nums ${rowFp > 0 ? "text-red-400" : "text-faint"}`}>
                            {rowFp > 0 ? rowFp : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>

                  <tfoot>
                    <tr className="border-t border-line2 bg-panel/40">
                      <td className="px-4 py-2.5 text-faint font-medium">합계</td>
                      {eventNames.map((ev) => {
                        const colTp = rows.filter((r) => r.event_name === ev).reduce((s, r) => s + r.tp, 0);
                        const colFp = rows.filter((r) => r.event_name === ev).reduce((s, r) => s + r.fp, 0);
                        return (
                          <Fragment key={ev}>
                            <td className="px-3 py-2.5 text-center font-mono font-semibold tabular-nums text-green-400 border-l border-line">
                              {colTp > 0 ? colTp : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-center font-mono font-semibold tabular-nums text-red-400">
                              {colFp > 0 ? colFp : "—"}
                            </td>
                          </Fragment>
                        );
                      })}
                      <td className="px-3 py-2.5 text-center font-mono font-bold tabular-nums text-green-400 border-l border-line">
                        {rows.reduce((s, r) => s + r.tp, 0) || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono font-bold tabular-nums text-red-400">
                        {rows.reduce((s, r) => s + r.fp, 0) || "—"}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────
function StatCard({
  label, value, pct, color,
}: {
  label: string; value: number; pct?: number;
  color: "cyan" | "green" | "red" | "purple" | "amber";
}) {
  const textColor = {
    cyan:   "text-cyan-400",
    green:  "text-green-400",
    red:    "text-red-400",
    purple: "text-purple-400",
    amber:  "text-amber-400",
  }[color];

  return (
    <div className="bg-panel border border-line rounded-xl p-3">
      <p className="text-[10px] text-faint mb-1">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${textColor}`}>
        {value.toLocaleString()}
        <span className="text-xs font-normal text-faint ml-1">건</span>
      </p>
      {pct !== undefined && (
        <p className="text-[10px] text-faint mt-0.5">{pct}%</p>
      )}
    </div>
  );
}

const dateCls =
  "px-2 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-cyan-600";
