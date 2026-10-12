"use client";

import { useState, useEffect } from "react";
import { Customer } from "@/lib/types";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";

const CHART_COLORS = [
  "#06b6d4", "#f97316", "#a855f7", "#22c55e",
  "#eab308", "#ec4899", "#3b82f6", "#ef4444",
];

// ─── Timezone-aware date utils ────────────────────────────────────────────
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date());
}
function nDaysAgoInTz(n: number, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(
    new Date(Date.now() - n * 86_400_000),
  );
}
// ─────────────────────────────────────────────────────────────────────────

// 시간별 조회 시 0~23시 전체 표시
const ALL_HOURS = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, "0"));

interface StatsRow {
  bucket: string;
  event_name: string;
  count: number;
}

interface StatsResponse {
  rows: StatsRow[];
  total: number;
  groupBy: string;
  from: string;
  to: string;
}

type GroupBy = "today" | "day" | "week" | "month" | "custom" | "camera" | "hour";

const GROUP_LABELS: Record<GroupBy, string> = {
  today: "당일", day: "일별 추이", week: "주간", month: "월별", custom: "커스텀",
  camera: "카메라별", hour: "시간별",
};

// "YYYY-MM" → 그 달의 1일~말일 from/to
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate(); // m 은 1~12, 결과는 m 월 말일
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

// "YYYY" → 그 해 1월 1일~12월 31일 from/to
function yearRange(year: string): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function presetRange(gb: GroupBy, tz: string): { from: string; to: string } {
  const today = todayInTz(tz);
  if (gb === "today") return { from: today, to: today };
  if (gb === "day")   return { from: nDaysAgoInTz(6, tz), to: today }; // 7일 (오늘 포함)
  if (gb === "week")  return monthRange(today.slice(0, 7));            // 이번 달
  if (gb === "month") return yearRange(today.slice(0, 4));             // 올해
  return { from: nDaysAgoInTz(7, tz), to: today };                     // custom/camera/hour
}

function bucketLabel(groupBy: GroupBy, bucket: string): string {
  if (groupBy === "month")  return bucket.slice(0, 7);
  if (groupBy === "week")   return `${bucket.slice(5, 7)}/${bucket.slice(8, 10)}~`;
  if (groupBy === "camera") return `CAM ${bucket}`;
  if (groupBy === "hour")   return `${bucket}시`;
  return bucket.slice(5); // today, day, custom
}

function bucketColHeader(groupBy: GroupBy): string {
  if (groupBy === "camera") return "카메라 ID";
  if (groupBy === "hour")   return "시간대";
  if (groupBy === "week")   return "주 시작일";
  if (groupBy === "month")  return "월";
  return "날짜";
}

interface Props {
  customer: Customer;
}

export default function EventStats({ customer }: Props) {
  const hasDb = !!(customer.dbPassword && customer.dbName);
  const tz    = customer.timezone ?? "Asia/Seoul";

  const [groupBy, setGroupBy]               = useState<GroupBy>("day");
  const [from, setFrom]                     = useState(() => nDaysAgoInTz(6, tz));
  const [to, setTo]                         = useState(() => todayInTz(tz));
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [eventOptions, setEventOptions]     = useState<string[]>([]);
  const [loading, setLoading]               = useState(false);
  const [stats, setStats]                   = useState<StatsResponse | null>(null);
  const [error, setError]                   = useState<string | null>(null);
  const [sortKey, setSortKey]               = useState<string | null>(null);
  const [sortDir, setSortDir]               = useState<"desc" | "asc">("desc");
  const [tableOpen, setTableOpen]           = useState(false);

  useEffect(() => {
    if (!hasDb) return;
    fetch(`/api/db/${customer.id}/crawl`)
      .then((r) => r.json())
      .then((d) => setEventOptions(d.events ?? []))
      .catch(() => {});
  }, [customer.id, hasDb]);

  async function fetchStats(gb: GroupBy, f: string, t: string, evs: string[]) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/db/${customer.id}/stats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: f, to: t,
          groupBy: gb === "custom" || gb === "today" ? "day" : gb,
          events: evs,
          timezone: tz,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "조회 실패"); setStats(null); }
      else          { setStats(data as StatsResponse); }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStats(null);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hasDb) return;
    fetchStats("day", nDaysAgoInTz(6, tz), todayInTz(tz), []);
  }, [hasDb, customer.id]);

  function handleGroupByChange(gb: GroupBy) {
    setGroupBy(gb);
    setSortKey(null);
    setSortDir("desc");
    if (gb !== "custom") {
      const range = presetRange(gb, tz);
      setFrom(range.from);
      setTo(range.to);
      fetchStats(gb, range.from, range.to, selectedEvents);
    }
  }

  function handleSort(key: string | null) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function toggleEvent(ev: string) {
    setSelectedEvents((prev) =>
      prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]
    );
  }

  // ─── Derived ─────────────────────────────────────────────────────────────
  const rows       = stats?.rows ?? [];
  const total      = stats?.total ?? 0;
  const eventNames = selectedEvents.length > 0
    ? [...selectedEvents].sort()
    : [...eventOptions].sort();

  // 시간별은 항상 00~23 전체 표시, 나머지는 데이터 기준
  const rawBuckets = groupBy === "hour"
    ? ALL_HOURS
    : Array.from(new Set(rows.map((r) => r.bucket))).sort();

  const countMap = new Map<string, number>();
  for (const r of rows) countMap.set(`${r.bucket}__${r.event_name}`, r.count);

  const sortedBuckets = sortKey === null
    ? rawBuckets
    : [...rawBuckets].sort((a, b) => {
        const aVal = sortKey === "__total__"
          ? eventNames.reduce((s, ev) => s + (countMap.get(`${a}__${ev}`) ?? 0), 0)
          : (countMap.get(`${a}__${sortKey}`) ?? 0);
        const bVal = sortKey === "__total__"
          ? eventNames.reduce((s, ev) => s + (countMap.get(`${b}__${ev}`) ?? 0), 0)
          : (countMap.get(`${b}__${sortKey}`) ?? 0);
        return sortDir === "desc" ? bVal - aVal : aVal - bVal;
      });

  // 시간축 grouping: today/day/week/month/custom — stat tile + sparkline
  // 카테고리축 grouping: camera/hour — 막대그래프
  const isTimeAxis = groupBy === "today" || groupBy === "day" || groupBy === "week" || groupBy === "month" || groupBy === "custom";

  // 버킷 라벨 (week → "1주차", month → "4월", 그 외 → bucketLabel 함수).
  // week 는 자연 정렬된 인덱스 +1, month 는 버킷에서 월 추출.
  const bucketLabelMap = new Map<string, string>();
  rawBuckets.forEach((bucket, idx) => {
    if (groupBy === "week") {
      bucketLabelMap.set(bucket, `${idx + 1}주차`);
    } else if (groupBy === "month") {
      bucketLabelMap.set(bucket, `${parseInt(bucket.slice(5, 7), 10)}월`);
    } else {
      bucketLabelMap.set(bucket, bucketLabel(groupBy, bucket));
    }
  });
  const getLabel = (bucket: string): string => bucketLabelMap.get(bucket) ?? bucket;

  // recharts 데이터: [{ label, [event_name]: count, ... }, ...]
  const chartData = sortedBuckets.map((bucket) => {
    const obj: Record<string, string | number> = {
      label: getLabel(bucket),
    };
    for (const ev of eventNames) {
      obj[ev] = countMap.get(`${bucket}__${ev}`) ?? 0;
    }
    return obj;
  });

  // 총 이벤트 sparkline용: bucket 별 합계
  const totalSpark = chartData.map((d) => ({
    label: d.label as string,
    y: eventNames.reduce((s, ev) => s + ((d[ev] as number) ?? 0), 0),
  }));

  // 이벤트 비율 도넛: 이벤트 종류별 합계 (값 0 인 이벤트는 제외).
  const pieData = eventNames
    .map((ev) => ({
      name: ev,
      value: rows.filter((r) => r.event_name === ev).reduce((s, r) => s + r.count, 0),
    }))
    .filter((d) => d.value > 0);
  // ─────────────────────────────────────────────────────────────────────────

  function downloadExcel() {
    if (!stats) return;
    const header = [bucketColHeader(groupBy), ...eventNames, "합계"];
    const dataRows = sortedBuckets.map((bucket) => {
      const rowTotal = eventNames.reduce((s, ev) => s + (countMap.get(`${bucket}__${ev}`) ?? 0), 0);
      return [getLabel(bucket), ...eventNames.map((ev) => countMap.get(`${bucket}__${ev}`) ?? 0), rowTotal];
    });
    const footRow = [
      "합계",
      ...eventNames.map((ev) => rows.filter((r) => r.event_name === ev).reduce((s, r) => s + r.count, 0)),
      total,
    ];
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows, footRow]);
    ws["!cols"] = [{ wch: 14 }, ...eventNames.map(() => ({ wch: 10 })), { wch: 8 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "이벤트통계");
    XLSX.writeFile(wb, `${customer.id}_이벤트통계_${from}_${to}.xlsx`);
  }

  function sortIcon(key: string | null) {
    if (sortKey !== key) return <span className="text-faint ml-1">↕</span>;
    return <span className="text-cyan-400 ml-1">{sortDir === "desc" ? "↓" : "↑"}</span>;
  }

  if (!hasDb) {
    return (
      <div className="border border-line rounded-xl p-4">
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 dark:text-amber-400 dark:bg-amber-900/20 dark:border-amber-800">
          DB 정보가 설정되지 않았습니다. 고객사 수정 페이지에서 DB 정보를 입력하면 이벤트 통계를 확인할 수 있습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-line rounded-xl overflow-hidden">

      {/* ── 필터 바 ── */}
      <div className="p-4 space-y-3 border-b border-line">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex rounded-lg overflow-hidden border border-line2 flex-wrap">
            {(["today", "day", "week", "month", "custom", "camera", "hour"] as GroupBy[]).map((gb) => (
              <button
                key={gb}
                onClick={() => handleGroupByChange(gb)}
                className={`px-3 py-1.5 text-xs transition-colors ${
                  groupBy === gb
                    ? "bg-cyan-700 text-ink"
                    : "bg-input text-muted hover:bg-gray-700"
                }`}
              >
                {GROUP_LABELS[gb]}
              </button>
            ))}
          </div>

          {groupBy === "today" ? (
            <div className="flex items-center gap-2">
              <label className="text-xs text-faint shrink-0">날짜</label>
              <input
                type="date"
                value={from}
                onChange={(e) => { setFrom(e.target.value); setTo(e.target.value); }}
                className={dateCls}
              />
            </div>
          ) : groupBy === "week" ? (
            <div className="flex items-center gap-2">
              <label className="text-xs text-faint shrink-0">월 선택</label>
              <input
                type="month"
                value={from.slice(0, 7)}
                onChange={(e) => {
                  if (!e.target.value) return;
                  const r = monthRange(e.target.value);
                  setFrom(r.from); setTo(r.to);
                }}
                className={dateCls}
              />
            </div>
          ) : groupBy === "month" ? (
            <div className="flex items-center gap-2">
              <label className="text-xs text-faint shrink-0">연도</label>
              <input
                type="number"
                min="2020"
                max="2099"
                value={from.slice(0, 4)}
                onChange={(e) => {
                  const y = e.target.value;
                  if (!/^\d{4}$/.test(y)) return;
                  const r = yearRange(y);
                  setFrom(r.from); setTo(r.to);
                }}
                className={`${dateCls} w-24`}
              />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={dateCls} />
              <span className="text-faint text-xs">~</span>
              <input type="date" value={to}   onChange={(e) => setTo(e.target.value)}   className={dateCls} />
            </div>
          )}

          <button
            onClick={() => fetchStats(groupBy, from, to, selectedEvents)}
            disabled={loading}
            className="px-4 py-1.5 text-xs bg-cyan-700 text-ink rounded-lg hover:bg-cyan-600 disabled:opacity-40 font-medium"
          >
            {loading ? "조회 중…" : "조회"}
          </button>
        </div>

        {eventOptions.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-faint shrink-0">이벤트:</span>
            {eventOptions.map((ev) => (
              <button
                key={ev}
                onClick={() => toggleEvent(ev)}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  selectedEvents.includes(ev)
                    ? "bg-cyan-900/60 border-cyan-700 text-cyan-400"
                    : "bg-input/60 border-line2 text-muted hover:border-gray-500"
                }`}
              >
                {ev}
              </button>
            ))}
            {selectedEvents.length > 0 && (
              <button onClick={() => setSelectedEvents([])} className="px-2.5 py-1 text-xs text-faint hover:text-muted">
                초기화
              </button>
            )}
          </div>
        )}
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
      {!loading && stats && (
        <>
          {/* 요약 카드 + Excel 버튼 */}
          <div className="flex items-start justify-between gap-3 p-4 border-b border-line">
            <div className="grid grid-cols-2 gap-3 flex-1">
              <div className="bg-panel border border-line rounded-xl p-3">
                <p className="text-xs text-faint mb-1">총 이벤트</p>
                <p className="text-2xl font-bold text-cyan-400 tabular-nums">{total}</p>
                {isTimeAxis && totalSpark.length > 1 && (
                  <div className="h-9 mt-2 -mx-1">
                    <ResponsiveContainer>
                      <BarChart data={totalSpark} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                        <XAxis dataKey="label" hide />
                        <Tooltip
                          contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 6, fontSize: 11, padding: "4px 8px" }}
                          labelStyle={{ color: "#9ca3af" }}
                          itemStyle={{ fontSize: 11 }}
                          cursor={{ fill: "#1f2937", opacity: 0.4 }}
                          formatter={(v: number) => [`${v}건`, "합계"]}
                        />
                        <Bar dataKey="y" fill="#06b6d4" fillOpacity={0.6} radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
              <div className="bg-panel border border-line rounded-xl p-3 flex flex-col">
                <p className="text-xs text-faint mb-1">이벤트 비율</p>
                {pieData.length > 0 ? (
                  <div className="flex items-center gap-3 flex-1">
                    {/* 도넛 차트 */}
                    <div className="relative w-[110px] h-[110px] shrink-0">
                      <ResponsiveContainer>
                        <PieChart>
                          <Pie
                            data={pieData}
                            dataKey="value"
                            nameKey="name"
                            innerRadius={32}
                            outerRadius={52}
                            paddingAngle={2}
                            stroke="none"
                          >
                            {pieData.map((_, i) => (
                              <Cell key={i} fill={CHART_COLORS[eventNames.indexOf(pieData[i].name) % CHART_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 6, fontSize: 11, padding: "4px 8px" }}
                            labelStyle={{ color: "#9ca3af" }}
                            itemStyle={{ fontSize: 11 }}
                            formatter={(v: number, name: string) => {
                              const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0";
                              return [`${v}건 (${pct}%)`, name];
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      {/* 가운데 총합 */}
                      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                        <span className="text-[9px] text-faint">총</span>
                        <span className="text-sm font-bold text-cyan-400 tabular-nums leading-tight">{total}</span>
                      </div>
                    </div>
                    {/* 범례 */}
                    <ul className="flex-1 space-y-0.5 text-[11px] min-w-0">
                      {pieData.map((d) => {
                        const color = CHART_COLORS[eventNames.indexOf(d.name) % CHART_COLORS.length];
                        const pct = total > 0 ? ((d.value / total) * 100).toFixed(0) : "0";
                        return (
                          <li key={d.name} className="flex items-center gap-1.5 min-w-0">
                            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
                            <span className="text-muted truncate flex-1">{d.name}</span>
                            <span className="text-faint tabular-nums shrink-0">{pct}%</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : (
                  <p className="text-2xl font-bold text-ink2">—</p>
                )}
              </div>
            </div>
            {rows.length > 0 && (
              <button
                onClick={downloadExcel}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-400 text-emerald-700 text-xs hover:bg-emerald-100 transition-colors whitespace-nowrap mt-0.5 dark:bg-emerald-900/40 dark:border-emerald-700/50 dark:text-emerald-400 dark:hover:bg-emerald-800/50"
              >
                ⬇ Excel
              </button>
            )}
          </div>

          {/* 시간축 모드 — 이벤트별 stat tile + sparkline */}
          {isTimeAxis && rows.length > 0 && eventNames.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 p-4 border-b border-line">
              {eventNames.map((ev, i) => {
                const evTotal = rows
                  .filter((r) => r.event_name === ev)
                  .reduce((s, r) => s + r.count, 0);
                const sparkData = chartData.map((d) => ({
                  label: d.label as string,
                  y: (d[ev] as number) ?? 0,
                }));
                let topD: { label: string; y: number } | null = null;
                for (const d of sparkData) {
                  if (d.y > 0 && (!topD || d.y > topD.y)) topD = d;
                }
                const color = CHART_COLORS[i % CHART_COLORS.length];
                return (
                  <div key={ev} className="bg-panel border border-line rounded-xl p-3">
                    <p className="text-xs text-gray-500 mb-1 truncate" title={ev}>{ev}</p>
                    <p className="text-2xl font-bold tabular-nums" style={{ color }}>{evTotal}</p>
                    {sparkData.length > 1 && (
                      <div className="h-9 mt-2 -mx-1">
                        <ResponsiveContainer>
                          <BarChart data={sparkData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                            <XAxis dataKey="label" hide />
                            <Tooltip
                              contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 6, fontSize: 11, padding: "4px 8px" }}
                              labelStyle={{ color: "#9ca3af" }}
                              itemStyle={{ fontSize: 11, color }}
                              cursor={{ fill: "#1f2937", opacity: 0.4 }}
                              formatter={(v: number) => [`${v}건`, ev]}
                            />
                            <Bar dataKey="y" fill={color} fillOpacity={0.7} radius={[2, 2, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                    <p className="text-[10px] text-gray-600 mt-1 truncate">
                      {topD ? `최다 ${topD.label} · ${topD.y}건` : "이벤트 없음"}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {rows.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-xs text-faint">조회된 이벤트 없음</p>
            </div>
          ) : (
            <>
              {!isTimeAxis && renderBarChart({ groupBy, chartData, eventNames })}

              {/* 상세 표 (접기) */}
              <div>
                <button
                  onClick={() => setTableOpen((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-faint hover:text-ink2 hover:bg-input/30 transition-colors"
                >
                  <span>
                    <span className="inline-block w-3 text-muted">{tableOpen ? "▼" : "▶"}</span>
                    {" "}상세 표
                    <span className="text-muted ml-2">({sortedBuckets.length}행 × {eventNames.length}열)</span>
                  </span>
                  <span className="text-muted">{tableOpen ? "접기" : "펼치기"}</span>
                </button>

                {tableOpen && (
                  <div className="overflow-x-auto border-t border-line">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-line2 bg-panel/60 text-faint">
                          <th
                            className="px-4 py-2.5 text-left font-medium w-24 whitespace-nowrap cursor-pointer hover:text-ink2 select-none"
                            onClick={() => handleSort(null)}
                          >
                            {bucketColHeader(groupBy)}{sortIcon(null)}
                          </th>
                          {eventNames.map((ev) => (
                            <th
                              key={ev}
                              className="px-4 py-2.5 text-right font-medium whitespace-nowrap cursor-pointer hover:text-ink2 select-none"
                              onClick={() => handleSort(ev)}
                            >
                              {ev}{sortIcon(ev)}
                            </th>
                          ))}
                          <th
                            className="px-4 py-2.5 text-right font-medium whitespace-nowrap border-l border-line2 text-muted cursor-pointer hover:text-ink2 select-none"
                            onClick={() => handleSort("__total__")}
                          >
                            합계{sortIcon("__total__")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line/50">
                        {sortedBuckets.map((bucket) => {
                          const rowTotal = eventNames.reduce(
                            (s, ev) => s + (countMap.get(`${bucket}__${ev}`) ?? 0), 0
                          );
                          return (
                            <tr key={bucket} className="hover:bg-input/20 transition-colors">
                              <td className="px-4 py-2 font-mono text-muted whitespace-nowrap">
                                {getLabel(bucket)}
                              </td>
                              {eventNames.map((ev) => {
                                const c = countMap.get(`${bucket}__${ev}`) ?? 0;
                                return (
                                  <td key={ev} className={`px-4 py-2 text-right font-mono tabular-nums ${c > 0 ? "text-ink2" : "text-faint"}`}>
                                    {c > 0 ? c : "—"}
                                  </td>
                                );
                              })}
                              <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-cyan-400 border-l border-line">
                                {rowTotal > 0 ? rowTotal : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-line2 bg-panel/40">
                          <td className="px-4 py-2.5 text-faint font-medium">합계</td>
                          {eventNames.map((ev) => {
                            const colTotal = rows.filter((r) => r.event_name === ev).reduce((s, r) => s + r.count, 0);
                            return (
                              <td key={ev} className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-ink2">
                                {colTotal > 0 ? colTotal : "—"}
                              </td>
                            );
                          })}
                          <td className="px-4 py-2.5 text-right font-mono font-bold tabular-nums text-cyan-400 border-l border-line">
                            {total}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

const dateCls =
  "px-2 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-cyan-600";

// 카메라/시간 모드용 스택 막대그래프 (시간축은 stat tile 로 대체).
function renderBarChart({
  groupBy,
  chartData,
  eventNames,
}: {
  groupBy: GroupBy;
  chartData: Record<string, string | number>[];
  eventNames: string[];
}) {
  const tooltip = (
    <Tooltip
      contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 8, fontSize: 11 }}
      labelStyle={{ color: "#9ca3af" }}
      itemStyle={{ fontSize: 11 }}
      cursor={{ fill: "#1f2937", opacity: 0.4 }}
    />
  );

  const isCamera = groupBy === "camera";
  // 카메라 모드에선 막대 1개당 ~28px 확보 → 모든 카메라가 압축 없이 표시.
  // 그 외 모드는 320px 고정.
  const chartHeight = isCamera
    ? Math.max(320, chartData.length * 28 + 60)
    : 320;

  return (
    <div className="px-3 pt-4 pb-2 border-b border-line">
      <div style={{ width: "100%", height: chartHeight }}>
        <ResponsiveContainer>
          <BarChart
            data={chartData}
            layout={isCamera ? "vertical" : "horizontal"}
            margin={isCamera ? { top: 8, right: 16, bottom: 4, left: 0 } : { top: 8, right: 16, bottom: 4, left: -16 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            {/* Recharts 는 Fragment 자식을 인식하지 못해 XAxis/YAxis 가 잠겨 막대가 안 그려짐.
                isCamera 분기를 형제 노드로 평탄화해야 함. */}
            {isCamera && <XAxis type="number" tick={{ fill: "#6b7280", fontSize: 10 }} allowDecimals={false} />}
            {isCamera && <YAxis type="category" dataKey="label" tick={{ fill: "#6b7280", fontSize: 10 }} width={70} />}
            {!isCamera && <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 10 }} interval={chartData.length > 20 ? "preserveStartEnd" : 0} />}
            {!isCamera && <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} allowDecimals={false} />}
            {tooltip}
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
            {eventNames.map((ev, i) => (
              <Bar
                key={ev}
                dataKey={ev}
                stackId="a"
                fill={CHART_COLORS[i % CHART_COLORS.length]}
                radius={!isCamera && i === eventNames.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
