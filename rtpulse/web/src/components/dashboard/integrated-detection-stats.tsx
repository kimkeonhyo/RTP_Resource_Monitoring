"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from "recharts";
import type { CustomerInfo } from "@/app/page";

// ── Types ──────────────────────────────────────────────────────────────────

type GroupBy  = "day" | "week" | "month";
type ViewMode = "merged" | "split" | "by-event";

interface DetectionRow {
  bucket:     string;
  event_name: string;
  tp:         number;
  fp:         number;
}

interface DetectionResponse {
  rows?:  DetectionRow[];
  error?: string;
}

type ChartDatum = { bucket: string } & Record<string, string | number>;

interface CustomerChart {
  id:      string;
  name:    string;
  data:    ChartDatum[];
  events:  string[];
  summary: { tp: number; fp: number };
}

// ── Color palettes ─────────────────────────────────────────────────────────

const TP_COLORS = ["#34d399", "#22d3ee", "#a3e635", "#4ade80", "#2dd4bf", "#86efac", "#67e8f9", "#bef264"];
const FP_COLORS = ["#f87171", "#fb923c", "#f472b6", "#fbbf24", "#e879f9", "#60a5fa", "#c084fc", "#fd8b6d"];

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(d: Date) { return d.toISOString().slice(0, 10); }

function defaultRange(gb: GroupBy) {
  const to   = new Date();
  const from = new Date();
  if      (gb === "month") from.setMonth(from.getMonth() - 12);
  else if (gb === "week")  from.setDate(from.getDate() - 90);
  else                     from.setDate(from.getDate() - 30);
  return { from: fmtDate(from), to: fmtDate(to) };
}

function mergeRows(all: DetectionRow[][]): DetectionRow[] {
  const map = new Map<string, { tp: number; fp: number }>();
  for (const rows of all)
    for (const r of rows) {
      const k   = `${r.bucket}\0${r.event_name}`;
      const cur = map.get(k) ?? { tp: 0, fp: 0 };
      map.set(k, { tp: cur.tp + r.tp, fp: cur.fp + r.fp });
    }
  return [...map.entries()].map(([k, v]) => {
    const i = k.indexOf("\0");
    return { bucket: k.slice(0, i), event_name: k.slice(i + 1), ...v };
  });
}

function toChart(rows: DetectionRow[]): { data: ChartDatum[]; events: string[] } {
  const events = [...new Set(rows.map((r) => r.event_name))].sort();
  const map    = new Map<string, ChartDatum>();
  for (const r of rows) {
    if (!map.has(r.bucket)) map.set(r.bucket, { bucket: r.bucket });
    const d = map.get(r.bucket)!;
    d[`${r.event_name}__tp`] = ((d[`${r.event_name}__tp`] as number) ?? 0) + r.tp;
    d[`${r.event_name}__fp`] = ((d[`${r.event_name}__fp`] as number) ?? 0) + r.fp;
  }
  for (const d of map.values())
    for (const ev of events) {
      if (d[`${ev}__tp`] == null) d[`${ev}__tp`] = 0;
      if (d[`${ev}__fp`] == null) d[`${ev}__fp`] = 0;
    }
  return {
    data:   [...map.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket))),
    events,
  };
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function IntegratedDetectionStats({ customers }: { customers: CustomerInfo[] }) {
  const allCustomers = useMemo(() => customers, [customers]);

  const [groupBy,     setGroupBy]     = useState<GroupBy>("day");
  const [range,       setRange]       = useState(() => defaultRange("day"));
  const [selIds,      setSelIds]      = useState<string[]>(() => allCustomers.map((c) => c.id));
  const [hidden,      setHidden]      = useState<Set<string>>(new Set());
  const [viewMode,    setViewMode]    = useState<ViewMode>("merged");
  const [chartData,   setChartData]   = useState<ChartDatum[]>([]);
  const [events,      setEvents]      = useState<string[]>([]);
  const [summary,     setSummary]     = useState({ tp: 0, fp: 0 });
  const [perCustomer, setPerCustomer] = useState<CustomerChart[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [errors,      setErrors]      = useState<string[]>([]);

  useEffect(() => {
    const selected = allCustomers.filter((c) => selIds.includes(c.id));
    if (selected.length === 0) { setChartData([]); setEvents([]); setPerCustomer([]); return; }

    let cancelled = false;
    setLoading(true);
    setErrors([]);

    Promise.allSettled(
      selected.map((c) =>
        fetch(`/api/nas/${c.id}/detection-stats`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ from: range.from, to: range.to, groupBy }),
        })
          .then((r) => r.json() as Promise<DetectionResponse>)
          .then((j) => {
            if (j.error) throw new Error(`${c.name}: ${j.error}`);
            return j.rows ?? [];
          })
      )
    ).then((results) => {
      if (cancelled) return;
      const allRows: DetectionRow[][] = [];
      const perC:    CustomerChart[]   = [];
      const errs:    string[]          = [];

      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          allRows.push(r.value);
          const { data, events } = toChart(r.value);
          const tp = r.value.reduce((s, row) => s + row.tp, 0);
          const fp = r.value.reduce((s, row) => s + row.fp, 0);
          perC.push({ id: selected[i].id, name: selected[i].name, data, events, summary: { tp, fp } });
        } else {
          errs.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      });

      const merged           = mergeRows(allRows);
      const { data, events } = toChart(merged);
      const tp               = merged.reduce((s, r) => s + r.tp, 0);
      const fp               = merged.reduce((s, r) => s + r.fp, 0);
      setChartData(data);
      setEvents(events);
      setSummary({ tp, fp });
      setPerCustomer(perC);
      setErrors(errs);
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [selIds, range.from, range.to, groupBy, allCustomers]);

  const handleGroupBy = (gb: GroupBy) => { setGroupBy(gb); setRange(defaultRange(gb)); };
  const visibleEvents  = events.filter((ev) => !hidden.has(ev));
  const labeled        = summary.tp + summary.fp;

  // 이벤트별 보기: 이벤트마다 각 고객사의 TP/FP (이미 받은 perCustomer 재피벗)
  const byEventData = useMemo(() =>
    events.map((ev) => {
      const cust = perCustomer
        .map((c) => ({
          name: c.name,
          tp: c.data.reduce((s, d) => s + ((d[`${ev}__tp`] as number) ?? 0), 0),
          fp: c.data.reduce((s, d) => s + ((d[`${ev}__fp`] as number) ?? 0), 0),
        }))
        .filter((x) => x.tp + x.fp > 0)
        .sort((a, b) => (b.tp + b.fp) - (a.tp + a.fp));
      return {
        event: ev, customers: cust,
        tp: cust.reduce((s, x) => s + x.tp, 0),
        fp: cust.reduce((s, x) => s + x.fp, 0),
      };
    }).filter((e) => e.tp + e.fp > 0),
    [events, perCustomer]);

  if (allCustomers.length === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-6 text-center text-sm text-faint">
        등록된 고객사가 없습니다.
      </div>
    );
  }

  return (
    <div className="bg-panel border border-line rounded-xl p-5 space-y-4">

      {/* ── 요약 수치 (통합 모드만) ── */}
      {viewMode === "merged" && !loading && labeled > 0 && (
        <div className="flex items-center gap-4 text-xs">
          <span className="text-faint">
            라벨링 <span className="text-ink font-semibold">{labeled.toLocaleString()}</span>건
          </span>
          <span className="text-emerald-400">
            TP <span className="font-semibold">{summary.tp.toLocaleString()}</span>
          </span>
          <span className="text-red-400">
            FP <span className="font-semibold">{summary.fp.toLocaleString()}</span>
          </span>
          {labeled > 0 && (
            <span className="text-faint">
              정확도 <span className="text-ink font-semibold">{((summary.tp / labeled) * 100).toFixed(1)}%</span>
            </span>
          )}
        </div>
      )}

      {/* ── 필터 바 ── */}
      <div className="flex flex-wrap items-center gap-3">
        <GroupByToggle value={groupBy} onChange={handleGroupBy} />
        <DateRange range={range} onChange={setRange} />
        <MultiSelect
          label="고객사"
          options={allCustomers.map((c) => ({ value: c.id, label: c.name }))}
          selected={selIds}
          onChange={setSelIds}
        />
        <ViewToggle value={viewMode} onChange={setViewMode} />
        {loading && <span className="text-xs text-faint animate-pulse">로딩 중...</span>}
      </div>

      {/* ── 이벤트 칩 (통합 모드만) ── */}
      {viewMode === "merged" && events.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {events.map((ev, i) => {
            const isHidden = hidden.has(ev);
            return (
              <button
                key={ev}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    isHidden ? next.delete(ev) : next.add(ev);
                    return next;
                  })
                }
                className="px-2.5 py-0.5 rounded-full text-xs border transition-all"
                style={
                  isHidden
                    ? { borderColor: "#374151", color: "#4b5563" }
                    : {
                        backgroundColor: TP_COLORS[i % TP_COLORS.length] + "22",
                        borderColor:     TP_COLORS[i % TP_COLORS.length] + "66",
                        color:           TP_COLORS[i % TP_COLORS.length],
                      }
                }
              >
                {ev}
              </button>
            );
          })}
        </div>
      )}

      {/* ── 에러 ── */}
      {errors.length > 0 && (
        <div className="text-xs text-amber-500/80 space-y-0.5">
          {errors.map((e, i) => <p key={i}>⚠ {e}</p>)}
        </div>
      )}

      {/* ── 통합 차트 ── */}
      {viewMode === "merged" && (
        !loading && chartData.length === 0 ? (
          <p className="text-xs text-faint py-10 text-center">데이터가 없습니다.</p>
        ) : (
          <div style={{ height: 340 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 36 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-line))" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tick={{ fontSize: 10, fill: "#6b7280" }}
                  angle={chartData.length > 6 ? -35 : 0}
                  textAnchor={chartData.length > 6 ? "end" : "middle"}
                  interval={0}
                />
                <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} width={32} allowDecimals={false} />
                <Tooltip content={<DetectionTooltip events={events} />} cursor={{ fill: "#ffffff08" }} />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                  formatter={(v) => {
                    const [evName, kind] = String(v).split("__");
                    return (
                      <span style={{ color: "#9ca3af" }}>
                        {evName} {kind === "tp" ? "(TP)" : "(FP)"}
                      </span>
                    );
                  }}
                />
                {visibleEvents.map((ev, i) => (
                  <Bar key={`${ev}__tp`} dataKey={`${ev}__tp`} name={`${ev}__tp`} stackId="tp"
                    fill={TP_COLORS[events.indexOf(ev) % TP_COLORS.length]}
                    radius={i === visibleEvents.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]} />
                ))}
                {visibleEvents.map((ev, i) => (
                  <Bar key={`${ev}__fp`} dataKey={`${ev}__fp`} name={`${ev}__fp`} stackId="fp"
                    fill={FP_COLORS[events.indexOf(ev) % FP_COLORS.length]}
                    radius={i === visibleEvents.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )
      )}

      {/* ── 고객사별 차트 ── */}
      {viewMode === "split" && (
        !loading && perCustomer.length === 0 ? (
          <p className="text-xs text-faint py-10 text-center">데이터가 없습니다.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {perCustomer.map((c) => {
              const cLabeled = c.summary.tp + c.summary.fp;
              return (
                <div key={c.id} className="bg-input/50 border border-line2/50 rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-200">{c.name}</span>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-emerald-400">TP {c.summary.tp.toLocaleString()}</span>
                      <span className="text-red-400">FP {c.summary.fp.toLocaleString()}</span>
                      {cLabeled > 0 && (
                        <span className="text-faint">
                          {((c.summary.tp / cLabeled) * 100).toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </div>
                  {c.data.length === 0 ? (
                    <p className="text-xs text-faint py-6 text-center">데이터 없음</p>
                  ) : (
                    <div style={{ height: 220 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={c.data} margin={{ top: 2, right: 4, left: 0, bottom: 28 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-line))" vertical={false} />
                          <XAxis
                            dataKey="bucket"
                            tick={{ fontSize: 9, fill: "#6b7280" }}
                            angle={c.data.length > 6 ? -35 : 0}
                            textAnchor={c.data.length > 6 ? "end" : "middle"}
                            interval={0}
                          />
                          <YAxis tick={{ fontSize: 9, fill: "#6b7280" }} width={28} allowDecimals={false} />
                          <Tooltip content={<DetectionTooltip events={c.events} />} cursor={{ fill: "#ffffff08" }} />
                          {c.events.map((ev, i) => (
                            <Bar key={`${ev}__tp`} dataKey={`${ev}__tp`} name={`${ev}__tp`} stackId="tp"
                              fill={TP_COLORS[events.indexOf(ev) !== -1 ? events.indexOf(ev) % TP_COLORS.length : i % TP_COLORS.length]}
                              radius={i === c.events.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]} />
                          ))}
                          {c.events.map((ev, i) => (
                            <Bar key={`${ev}__fp`} dataKey={`${ev}__fp`} name={`${ev}__fp`} stackId="fp"
                              fill={FP_COLORS[events.indexOf(ev) !== -1 ? events.indexOf(ev) % FP_COLORS.length : i % FP_COLORS.length]}
                              radius={i === c.events.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]} />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ── 이벤트별 차트 (이벤트마다 고객사 TP/FP) ── */}
      {viewMode === "by-event" && (
        !loading && byEventData.length === 0 ? (
          <p className="text-xs text-faint py-10 text-center">데이터가 없습니다.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {byEventData.map((e) => {
              const color = TP_COLORS[events.indexOf(e.event) % TP_COLORS.length];
              const lab = e.tp + e.fp;
              return (
                <div key={e.event} className="bg-input/50 border border-line2/50 rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium" style={{ color }}>{e.event}</span>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-emerald-400">TP {e.tp.toLocaleString()}</span>
                      <span className="text-red-400">FP {e.fp.toLocaleString()}</span>
                      {lab > 0 && <span className="text-faint">{((e.tp / lab) * 100).toFixed(1)}%</span>}
                    </div>
                  </div>
                  <div style={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={e.customers} margin={{ top: 2, right: 4, left: 0, bottom: 28 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-line))" vertical={false} />
                        <XAxis
                          dataKey="name"
                          tick={{ fontSize: 9, fill: "#6b7280" }}
                          angle={e.customers.length > 4 ? -35 : 0}
                          textAnchor={e.customers.length > 4 ? "end" : "middle"}
                          interval={0}
                        />
                        <YAxis tick={{ fontSize: 9, fill: "#6b7280" }} width={28} allowDecimals={false} />
                        <Tooltip content={<TpFpTooltip />} cursor={{ fill: "#ffffff08" }} />
                        <Bar dataKey="tp" name="TP" stackId="tp" fill="#34d399" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="fp" name="FP" stackId="fp" fill="#f87171" radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

// ── Tooltip ────────────────────────────────────────────────────────────────

function TpFpTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const tp = payload.find((p) => p.name === "TP")?.value ?? 0;
  const fp = payload.find((p) => p.name === "FP")?.value ?? 0;
  const lab = tp + fp;
  return (
    <div className="bg-panel border border-line2 rounded-xl px-3 py-2.5 text-xs shadow-2xl min-w-[140px]">
      <p className="text-muted mb-2">{label}</p>
      <div className="flex gap-3">
        <span className="text-emerald-400">TP {tp.toLocaleString()}</span>
        <span className="text-red-400">FP {fp.toLocaleString()}</span>
        {lab > 0 && <span className="text-faint">{((tp / lab) * 100).toFixed(1)}%</span>}
      </div>
    </div>
  );
}

function DetectionTooltip({
  active, payload, label, events,
}: {
  active?:  boolean;
  payload?: { name: string; value: number; fill: string }[];
  label?:   string;
  events:   string[];
}) {
  if (!active || !payload?.length) return null;

  const byEvent: Record<string, { tp: number; fp: number; tpColor: string; fpColor: string }> = {};
  for (const p of payload) {
    const [evName, kind] = p.name.split("__");
    if (!byEvent[evName]) byEvent[evName] = { tp: 0, fp: 0, tpColor: "", fpColor: "" };
    if (kind === "tp") { byEvent[evName].tp = p.value; byEvent[evName].tpColor = p.fill; }
    if (kind === "fp") { byEvent[evName].fp = p.value; byEvent[evName].fpColor = p.fill; }
  }

  const totalTp = Object.values(byEvent).reduce((s, v) => s + v.tp, 0);
  const totalFp = Object.values(byEvent).reduce((s, v) => s + v.fp, 0);
  const visibleEvents = events.filter((ev) => byEvent[ev] && (byEvent[ev].tp + byEvent[ev].fp) > 0);

  return (
    <div className="bg-panel border border-line2 rounded-xl px-3 py-2.5 text-xs shadow-2xl min-w-[160px]">
      <p className="text-muted mb-2">{label}</p>
      {visibleEvents.map((ev) => {
        const d = byEvent[ev];
        return (
          <div key={ev} className="mb-1">
            <p className="text-ink2">{ev}</p>
            <div className="flex gap-3 pl-2">
              <span style={{ color: d.tpColor }}>TP {d.tp.toLocaleString()}</span>
              <span style={{ color: d.fpColor }}>FP {d.fp.toLocaleString()}</span>
            </div>
          </div>
        );
      })}
      {visibleEvents.length > 1 && (
        <div className="border-t border-line mt-1.5 pt-1.5 flex gap-3">
          <span className="text-emerald-400">TP 합 {totalTp.toLocaleString()}</span>
          <span className="text-red-400">FP 합 {totalFp.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}

// ── 공용 소형 컴포넌트 ─────────────────────────────────────────────────────────

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-line2 text-xs">
      {([
        { v: "merged",   label: "통합 보기" },
        { v: "split",    label: "고객사별" },
        { v: "by-event", label: "이벤트별" },
      ] as { v: ViewMode; label: string }[]).map(({ v, label }) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-3 py-1.5 transition-colors ${
            value === v ? "bg-indigo-700 text-white" : "text-muted hover:text-white"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function GroupByToggle({ value, onChange }: { value: GroupBy; onChange: (g: GroupBy) => void }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-line2 text-xs">
      {(["day", "week", "month"] as GroupBy[]).map((g) => (
        <button
          key={g}
          onClick={() => onChange(g)}
          className={`px-3 py-1.5 transition-colors ${
            value === g ? "bg-cyan-700 text-white" : "text-muted hover:text-white"
          }`}
        >
          {g === "day" ? "일별" : g === "week" ? "주별" : "월별"}
        </button>
      ))}
    </div>
  );
}

function DateRange({
  range, onChange,
}: {
  range:    { from: string; to: string };
  onChange: (r: { from: string; to: string }) => void;
}) {
  const cls = "bg-input border border-line2 rounded-lg px-2 py-1.5 text-xs text-ink2 focus:outline-none focus:border-cyan-600";
  return (
    <div className="flex items-center gap-1.5">
      <input type="date" value={range.from} onChange={(e) => onChange({ ...range, from: e.target.value })} className={cls} />
      <span className="text-faint text-xs">~</span>
      <input type="date" value={range.to}   onChange={(e) => onChange({ ...range, to:   e.target.value })} className={cls} />
    </div>
  );
}

function MultiSelect({
  label, options, selected, onChange,
}: {
  label:    string;
  options:  { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  const all      = selected.length === options.length;
  const btnLabel = all ? `${label} 전체` : `${label} ${selected.length}/${options.length}`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-input border border-line2 rounded-lg text-xs text-ink2 hover:border-gray-600 transition-colors"
      >
        {btnLabel}
        <svg className="w-3 h-3 text-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 top-full left-0 mt-1 bg-panel border border-line2 rounded-xl p-2 min-w-[180px] shadow-2xl max-h-64 overflow-y-auto">
          <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-input cursor-pointer text-xs text-muted">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => onChange(e.target.checked ? options.map((o) => o.value) : [])}
              className="accent-cyan-500"
            />
            전체 선택
          </label>
          <div className="h-px bg-line my-1" />
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-input cursor-pointer text-xs text-ink2">
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))
                }
                className="accent-cyan-500"
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
