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

interface StatsRow {
  bucket:     string;
  event_name: string;
  count:      number;
}

type ChartDatum = { bucket: string } & Record<string, string | number>;

interface CustomerChart {
  id:     string;
  name:   string;
  data:   ChartDatum[];
  events: string[];
  total:  number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const COLORS = [
  "#22d3ee", "#34d399", "#a3e635", "#fbbf24", "#f87171",
  "#e879f9", "#60a5fa", "#fb923c", "#4ade80", "#2dd4bf",
  "#c084fc", "#f472b6", "#86efac", "#67e8f9", "#bef264",
];

function fmtDate(d: Date) { return d.toISOString().slice(0, 10); }

function defaultRange(gb: GroupBy) {
  const to   = new Date();
  const from = new Date();
  if      (gb === "month") from.setMonth(from.getMonth() - 12);
  else if (gb === "week")  from.setDate(from.getDate() - 90);
  else                     from.setDate(from.getDate() - 30);
  return { from: fmtDate(from), to: fmtDate(to) };
}

function mergeRows(all: StatsRow[][]): StatsRow[] {
  const map = new Map<string, number>();
  for (const rows of all)
    for (const r of rows) {
      const k = `${r.bucket}\0${r.event_name}`;
      map.set(k, (map.get(k) ?? 0) + r.count);
    }
  return [...map.entries()].map(([k, count]) => {
    const i = k.indexOf("\0");
    return { bucket: k.slice(0, i), event_name: k.slice(i + 1), count };
  });
}

function toChart(rows: StatsRow[]): { data: ChartDatum[]; events: string[] } {
  const events = [...new Set(rows.map((r) => r.event_name))].sort();
  const map    = new Map<string, ChartDatum>();
  for (const r of rows) {
    if (!map.has(r.bucket)) map.set(r.bucket, { bucket: r.bucket });
    const d = map.get(r.bucket)!;
    d[r.event_name] = ((d[r.event_name] as number) ?? 0) + r.count;
  }
  for (const d of map.values())
    for (const ev of events) if (d[ev] == null) d[ev] = 0;
  return {
    data:   [...map.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket))),
    events,
  };
}

async function fetchCustomerStats(
  c: CustomerInfo,
  from: string,
  to: string,
  groupBy: GroupBy,
): Promise<StatsRow[]> {
  const isOnprem = c.networkType === "onprem";
  if (isOnprem) {
    const res = await fetch(`/api/nas/${c.id}/event-stats`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ from, to, groupBy }),
    });
    const j = await res.json() as { rows?: StatsRow[]; error?: string };
    if (j.error) throw new Error(`${c.name}: ${j.error}`);
    return j.rows ?? [];
  }
  const res = await fetch(`/api/db/${c.id}/stats`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ from, to, groupBy }),
  });
  const j = await res.json() as { rows?: StatsRow[]; error?: string };
  if (j.error) throw new Error(`${c.name}: ${j.error}`);
  return j.rows ?? [];
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function IntegratedEventStats({ customers }: { customers: CustomerInfo[] }) {
  const eligible = useMemo(
    () => customers.filter((c) => c.networkType === "onprem" || c.hasDb),
    [customers],
  );

  const [groupBy,       setGroupBy]       = useState<GroupBy>("day");
  const [range,         setRange]         = useState(() => defaultRange("day"));
  const [selIds,        setSelIds]        = useState<string[]>(() => eligible.map((c) => c.id));
  const [hidden,        setHidden]        = useState<Set<string>>(new Set());
  const [viewMode,      setViewMode]      = useState<ViewMode>("merged");
  const [chartData,     setChartData]     = useState<ChartDatum[]>([]);
  const [events,        setEvents]        = useState<string[]>([]);
  const [perCustomer,   setPerCustomer]   = useState<CustomerChart[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [errors,        setErrors]        = useState<string[]>([]);

  useEffect(() => {
    const selected = eligible.filter((c) => selIds.includes(c.id));
    if (selected.length === 0) { setChartData([]); setEvents([]); setPerCustomer([]); return; }

    let cancelled = false;
    setLoading(true);
    setErrors([]);

    Promise.allSettled(
      selected.map((c) => fetchCustomerStats(c, range.from, range.to, groupBy))
    ).then((results) => {
      if (cancelled) return;
      const allRows: StatsRow[][] = [];
      const perC:    CustomerChart[] = [];
      const errs:    string[] = [];

      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          allRows.push(r.value);
          const { data, events } = toChart(r.value);
          const total = r.value.reduce((s, row) => s + row.count, 0);
          perC.push({ id: selected[i].id, name: selected[i].name, data, events, total });
        } else {
          errs.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      });

      const merged           = mergeRows(allRows);
      const { data, events } = toChart(merged);
      setChartData(data);
      setEvents(events);
      setPerCustomer(perC);
      setErrors(errs);
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [selIds, range.from, range.to, groupBy, eligible]);

  const handleGroupBy = (gb: GroupBy) => { setGroupBy(gb); setRange(defaultRange(gb)); };

  const visible = events.filter((ev) => !hidden.has(ev));
  const total   = chartData.reduce((s, d) => s + visible.reduce((ss, ev) => ss + ((d[ev] as number) ?? 0), 0), 0);

  // 이벤트별 보기: 이벤트마다 어느 고객사에서 얼마나 나왔는지(이미 받은 perCustomer 재피벗)
  const byEventData = useMemo(() =>
    events.map((ev) => {
      const cust = perCustomer
        .map((c) => ({ name: c.name, count: c.data.reduce((s, d) => s + ((d[ev] as number) ?? 0), 0) }))
        .filter((x) => x.count > 0)
        .sort((a, b) => b.count - a.count);
      return { event: ev, customers: cust, total: cust.reduce((s, x) => s + x.count, 0) };
    }).filter((e) => e.total > 0),
    [events, perCustomer]);

  if (eligible.length === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-6 text-center text-sm text-faint">
        DB 또는 NAS 데이터가 있는 고객사가 없습니다.
      </div>
    );
  }

  return (
    <div className="bg-panel border border-line rounded-xl p-5 space-y-4">

      {/* ── 필터 바 ── */}
      <div className="flex flex-wrap items-center gap-3">
        <GroupByToggle value={groupBy} onChange={handleGroupBy} />
        <DateRange range={range} onChange={setRange} />
        <MultiSelect
          label="고객사"
          options={eligible.map((c) => ({
            value: c.id,
            label: c.networkType === "onprem" ? `${c.name} (폐쇄망)` : c.name,
          }))}
          selected={selIds}
          onChange={setSelIds}
        />
        <ViewToggle value={viewMode} onChange={setViewMode} />
        {loading && <span className="text-xs text-faint animate-pulse">로딩 중...</span>}
        {!loading && viewMode === "merged" && chartData.length > 0 && (
          <span className="text-xs text-faint">총 {total.toLocaleString()}건</span>
        )}
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
                        backgroundColor: COLORS[i % COLORS.length] + "22",
                        borderColor:     COLORS[i % COLORS.length] + "66",
                        color:           COLORS[i % COLORS.length],
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
          <div style={{ height: 320 }}>
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
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "#ffffff08" }} />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                  formatter={(v) => <span style={{ color: "#9ca3af" }}>{v}</span>}
                />
                {visible.map((ev, i) => (
                  <Bar
                    key={ev}
                    dataKey={ev}
                    stackId="s"
                    fill={COLORS[events.indexOf(ev) % COLORS.length]}
                    radius={i === visible.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                  />
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
            {perCustomer.map((c) => (
              <div key={c.id} className="bg-input/50 border border-line2/50 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-200">{c.name}</span>
                  <span className="text-xs text-faint">{c.total.toLocaleString()}건</span>
                </div>
                {c.data.length === 0 ? (
                  <p className="text-xs text-faint py-6 text-center">데이터 없음</p>
                ) : (
                  <div style={{ height: 200 }}>
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
                        <Tooltip content={<ChartTooltip />} cursor={{ fill: "#ffffff08" }} />
                        {c.events.map((ev, i) => (
                          <Bar
                            key={ev}
                            dataKey={ev}
                            stackId="s"
                            fill={COLORS[events.indexOf(ev) !== -1 ? events.indexOf(ev) % COLORS.length : i % COLORS.length]}
                            radius={i === c.events.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* ── 이벤트별 차트 (이벤트마다 고객사 분포) ── */}
      {viewMode === "by-event" && (
        !loading && byEventData.length === 0 ? (
          <p className="text-xs text-faint py-10 text-center">데이터가 없습니다.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {byEventData.map((e) => {
              const color = COLORS[events.indexOf(e.event) % COLORS.length];
              return (
                <div key={e.event} className="bg-input/50 border border-line2/50 rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium" style={{ color }}>{e.event}</span>
                    <span className="text-xs text-faint">{e.total.toLocaleString()}건</span>
                  </div>
                  <div style={{ height: 200 }}>
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
                        <Tooltip content={<ChartTooltip />} cursor={{ fill: "#ffffff08" }} />
                        <Bar dataKey="count" name={e.event} fill={color} radius={[2, 2, 0, 0]} />
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
  range: { from: string; to: string };
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
    const fn = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
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

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; fill: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const items = payload.filter((p) => p.value > 0);
  const total = items.reduce((s, p) => s + p.value, 0);
  return (
    <div className="bg-panel border border-line2 rounded-xl px-3 py-2.5 text-xs shadow-2xl min-w-[140px]">
      <p className="text-muted mb-2">{label}</p>
      {items.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span style={{ color: p.fill }}>{p.name}</span>
          <span className="text-ink font-medium">{p.value.toLocaleString()}</span>
        </div>
      ))}
      {items.length > 1 && (
        <div className="border-t border-line mt-1.5 pt-1.5 flex justify-between">
          <span className="text-faint">합계</span>
          <span className="text-ink font-semibold">{total.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
