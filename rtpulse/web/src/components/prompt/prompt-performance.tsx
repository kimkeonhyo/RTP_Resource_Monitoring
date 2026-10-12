"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from "recharts";

// ── Types ──────────────────────────────────────────────────────────────────

type GroupBy  = "day" | "week" | "month";
type ViewMode = "merged" | "customer" | "version";
type Metric   = "tpfp" | "fp" | "fn";

interface Customer { id: string; name: string }

interface PerfRow {
  bucket:         string;
  prompt_version: string;
  tp: number; fp: number; tn: number; fn: number;
}

interface VersionRow {
  prompt_version: string;
  applied_at:     string | null;
  tp: number; fp: number; tn: number; fn: number; total: number;
}

interface PerfResponse {
  rows?:     PerfRow[];
  versions?: VersionRow[];
  error?:    string;
}

interface CustomerPerf {
  id:       string;
  name:     string;
  rows:     PerfRow[];
  versions: VersionRow[];
}

type ChartDatum = { bucket: string } & Record<string, string | number>;

// ── Color palettes (kind 별 명도 변주로 버전 구분) ───────────────────────────

const TP_COLORS = ["#34d399", "#22d3ee", "#a3e635", "#4ade80", "#2dd4bf", "#86efac", "#67e8f9", "#bef264"];
const FP_COLORS = ["#f87171", "#fb923c", "#f472b6", "#fbbf24", "#e879f9", "#60a5fa", "#c084fc", "#fd8b6d"];
const FN_COLORS = ["#fbbf24", "#f59e0b", "#fcd34d", "#fb923c", "#eab308", "#facc15", "#d97706", "#fde68a"];

const METRIC_KINDS: Record<Metric, ("tp" | "fp" | "fn")[]> = {
  tpfp: ["tp", "fp"],
  fp:   ["fp"],
  fn:   ["fn"],
};

function kindColor(kind: "tp" | "fp" | "fn", versionIdx: number): string {
  const pal = kind === "tp" ? TP_COLORS : kind === "fp" ? FP_COLORS : FN_COLORS;
  return pal[versionIdx % pal.length];
}

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

/** rows → recharts data + 버전 목록. metric 에 따라 version__kind 키 생성 */
function toChart(rows: PerfRow[], metric: Metric, versionOrder: string[]): ChartDatum[] {
  const kinds = METRIC_KINDS[metric];
  const map   = new Map<string, ChartDatum>();
  for (const r of rows) {
    if (!map.has(r.bucket)) map.set(r.bucket, { bucket: r.bucket });
    const d = map.get(r.bucket)!;
    for (const k of kinds) {
      const key = `${r.prompt_version}__${k}`;
      d[key] = ((d[key] as number) ?? 0) + (r[k] as number);
    }
  }
  // 모든 버전·kind 키를 0으로 채워 누락 방지
  for (const d of map.values())
    for (const v of versionOrder)
      for (const k of kinds)
        if (d[`${v}__${k}`] == null) d[`${v}__${k}`] = 0;
  return [...map.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
}

function mergeRows(all: PerfRow[][]): PerfRow[] {
  const map = new Map<string, PerfRow>();
  for (const rows of all)
    for (const r of rows) {
      const key = `${r.bucket}\0${r.prompt_version}`;
      const cur = map.get(key);
      if (cur) { cur.tp += r.tp; cur.fp += r.fp; cur.tn += r.tn; cur.fn += r.fn; }
      else      map.set(key, { ...r });
    }
  return [...map.values()];
}

/** 버전 정렬: applied_at 오름차순, '미지정'은 마지막 */
function sortVersions(versions: VersionRow[]): string[] {
  const seen = new Map<string, string | null>();
  for (const v of versions) if (!seen.has(v.prompt_version)) seen.set(v.prompt_version, v.applied_at);
  return [...seen.keys()].sort((a, b) => {
    if (a === "미지정") return 1;
    if (b === "미지정") return -1;
    const da = seen.get(a) ?? "", db = seen.get(b) ?? "";
    return String(da).localeCompare(String(db)) || a.localeCompare(b);
  });
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function PromptPerformance() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [groupBy,   setGroupBy]   = useState<GroupBy>("day");
  const [range,     setRange]     = useState(() => defaultRange("day"));
  const [selIds,    setSelIds]    = useState<string[]>([]);
  const [viewMode,  setViewMode]  = useState<ViewMode>("merged");
  const [metric,    setMetric]    = useState<Metric>("tpfp");
  const [perfs,     setPerfs]     = useState<CustomerPerf[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [errors,    setErrors]    = useState<string[]>([]);

  // 고객사 목록 로드
  useEffect(() => {
    fetch("/api/customers")
      .then((r) => r.json())
      .then((list: Customer[]) => {
        setCustomers(list);
        setSelIds(list.map((c) => c.id));
      })
      .catch(() => setErrors(["고객사 목록을 불러오지 못했습니다."]));
  }, []);

  // 데이터 로드
  useEffect(() => {
    const selected = customers.filter((c) => selIds.includes(c.id));
    if (selected.length === 0) { setPerfs([]); return; }

    let cancelled = false;
    setLoading(true);
    setErrors([]);

    Promise.allSettled(
      selected.map((c) =>
        fetch(`/api/nas/${c.id}/prompt-performance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: range.from, to: range.to, groupBy }),
        })
          .then((r) => r.json() as Promise<PerfResponse>)
          .then((j) => {
            if (j.error) throw new Error(`${c.name}: ${j.error}`);
            return { id: c.id, name: c.name, rows: j.rows ?? [], versions: j.versions ?? [] };
          })
      )
    ).then((results) => {
      if (cancelled) return;
      const out: CustomerPerf[] = [];
      const errs: string[] = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") out.push(r.value);
        else errs.push(r.reason instanceof Error ? r.reason.message : `${selected[i].name}: 오류`);
      });
      setPerfs(out);
      setErrors(errs);
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [selIds, range.from, range.to, groupBy, customers]);

  const handleGroupBy = (gb: GroupBy) => { setGroupBy(gb); setRange(defaultRange(gb)); };

  // 통합(merged)용 집계
  const mergedRows     = useMemo(() => mergeRows(perfs.map((p) => p.rows)), [perfs]);
  const allVersions    = useMemo(
    () => sortVersions(perfs.flatMap((p) => p.versions)),
    [perfs],
  );
  const mergedChart    = useMemo(() => toChart(mergedRows, metric, allVersions), [mergedRows, metric, allVersions]);

  // 버전별(version)용: 버전 → 병합된 rows
  const perVersionRows = useMemo(() => {
    const byVer = new Map<string, PerfRow[]>();
    for (const r of mergedRows) {
      if (!byVer.has(r.prompt_version)) byVer.set(r.prompt_version, []);
      byVer.get(r.prompt_version)!.push(r);
    }
    return byVer;
  }, [mergedRows]);

  const hasData = perfs.some((p) => p.rows.length > 0);

  return (
    <div className="space-y-5">
      {/* ── 필터 바 ── */}
      <div className="bg-panel border border-line rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <GroupByToggle value={groupBy} onChange={handleGroupBy} />
          <DateRange range={range} onChange={setRange} />
          <MultiSelect
            label="고객사"
            options={customers.map((c) => ({ value: c.id, label: c.name }))}
            selected={selIds}
            onChange={setSelIds}
          />
          <ViewToggle value={viewMode} onChange={setViewMode} />
          <MetricToggle value={metric} onChange={setMetric} />
          {loading && <span className="text-xs text-faint animate-pulse">로딩 중...</span>}
        </div>

        {errors.length > 0 && (
          <div className="text-xs text-amber-500/80 space-y-0.5">
            {errors.map((e, i) => <p key={i}>⚠ {e}</p>)}
          </div>
        )}

        {/* ── 차트 영역 ── */}
        {!loading && !hasData ? (
          <p className="text-xs text-faint py-10 text-center">집계할 라벨링 데이터가 없습니다.</p>
        ) : viewMode === "merged" ? (
          <PerfChart data={mergedChart} versions={allVersions} metric={metric} height={360} />
        ) : viewMode === "customer" ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {perfs.filter((p) => p.rows.length > 0).map((p) => {
              const vers = sortVersions(p.versions);
              return (
                <div key={p.id} className="bg-input/40 border border-line2/50 rounded-xl p-4 space-y-2">
                  <span className="text-sm font-medium text-gray-200">{p.name}</span>
                  <PerfChart data={toChart(p.rows, metric, vers)} versions={vers} metric={metric} height={220} compact />
                </div>
              );
            })}
          </div>
        ) : (
          // 프롬프트별
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {allVersions.filter((v) => (perVersionRows.get(v)?.length ?? 0) > 0).map((v) => (
              <div key={v} className="bg-input/40 border border-line2/50 rounded-xl p-4 space-y-2">
                <span className="text-sm font-medium text-gray-200 font-mono">{v}</span>
                <PerfChart data={toChart(perVersionRows.get(v) ?? [], metric, [v])} versions={[v]} metric={metric} height={220} compact />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 성능 표 (고객사 × 버전) ── */}
      <PerformanceTable perfs={perfs} />
    </div>
  );
}

// ── 차트 ──────────────────────────────────────────────────────────────────────

function PerfChart({
  data, versions, metric, height, compact,
}: {
  data: ChartDatum[]; versions: string[]; metric: Metric; height: number; compact?: boolean;
}) {
  const kinds = METRIC_KINDS[metric];
  if (data.length === 0) return <p className="text-xs text-faint py-6 text-center">데이터 없음</p>;

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: compact ? 28 : 36 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-line))" vertical={false} />
          <XAxis
            dataKey="bucket"
            tick={{ fontSize: compact ? 9 : 10, fill: "#6b7280" }}
            angle={data.length > 6 ? -35 : 0}
            textAnchor={data.length > 6 ? "end" : "middle"}
            interval={0}
          />
          <YAxis tick={{ fontSize: compact ? 9 : 10, fill: "#6b7280" }} width={compact ? 28 : 32} allowDecimals={false} />
          <Tooltip content={<PerfTooltip versions={versions} />} cursor={{ fill: "#ffffff08" }} />
          {!compact && (
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
              formatter={(val) => {
                const [ver, kind] = String(val).split("__");
                const label = kind === "tp" ? "정탐" : kind === "fp" ? "오탐" : "미탐";
                return <span style={{ color: "#9ca3af" }}>{ver} ({label})</span>;
              }}
            />
          )}
          {kinds.map((k) =>
            versions.map((v, vi) => (
              <Bar
                key={`${v}__${k}`}
                dataKey={`${v}__${k}`}
                name={`${v}__${k}`}
                stackId={k}
                fill={kindColor(k, vi)}
              />
            ))
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function PerfTooltip({
  active, payload, label, versions,
}: {
  active?: boolean;
  payload?: { name: string; value: number; fill: string }[];
  label?: string;
  versions: string[];
}) {
  if (!active || !payload?.length) return null;

  const byVer: Record<string, { tp: number; fp: number; fn: number; color: string }> = {};
  for (const p of payload) {
    const [ver, kind] = p.name.split("__");
    if (!byVer[ver]) byVer[ver] = { tp: 0, fp: 0, fn: 0, color: p.fill };
    if (kind === "tp") byVer[ver].tp = p.value;
    if (kind === "fp") byVer[ver].fp = p.value;
    if (kind === "fn") byVer[ver].fn = p.value;
  }

  const visible = versions.filter((v) => byVer[v] && (byVer[v].tp + byVer[v].fp + byVer[v].fn) > 0);
  if (visible.length === 0) return null;

  return (
    <div className="bg-panel border border-line2 rounded-xl px-3 py-2.5 text-xs shadow-2xl min-w-[160px]">
      <p className="text-muted mb-2">{label}</p>
      {visible.map((v) => {
        const d = byVer[v];
        return (
          <div key={v} className="mb-1">
            <p className="text-ink2 font-mono" style={{ color: d.color }}>{v}</p>
            <div className="flex gap-3 pl-2 text-faint">
              {d.tp > 0 && <span className="text-emerald-400">정탐 {d.tp.toLocaleString()}</span>}
              {d.fp > 0 && <span className="text-red-400">오탐 {d.fp.toLocaleString()}</span>}
              {d.fn > 0 && <span className="text-amber-400">미탐 {d.fn.toLocaleString()}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 성능 표 ────────────────────────────────────────────────────────────────────

type TableGroup = "customer" | "version";

/** 표 한 행에 들어가는 집계값 + 라벨(버전명 또는 고객사명) */
interface StatRow {
  label:      string;        // 버전명(고객사별 보기) 또는 고객사명(버전별 보기)
  applied_at: string | null; // 버전별 보기에서 적용일
  tp: number; fp: number; tn: number; fn: number; total: number;
}

function StatTable({ headLabel, rows }: { headLabel: string; rows: StatRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-input/70 text-[10px] text-muted uppercase tracking-wider">
            {[headLabel, "적용일", "정탐 TP", "오탐 FP", "정상 TN", "미탐 FN", "전체", "정확도", "오탐률", "F1-Score"].map((h) => (
              <th key={h} className="px-2.5 py-2 text-left font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((v) => {
            const labeled = v.tp + v.fp;
            const acc = labeled > 0 ? (v.tp / labeled) * 100 : null;
            const fpr = labeled > 0 ? (v.fp / labeled) * 100 : null;
            const f1Denom = 2 * v.tp + v.fp + v.fn;
            const f1 = f1Denom > 0 ? (2 * v.tp) / f1Denom : null;
            const f1Cls = f1 === null ? "text-faint" : f1 >= 0.8 ? "text-emerald-400" : f1 >= 0.5 ? "text-amber-400" : "text-red-400";
            return (
              <tr key={v.label} className="hover:bg-input/30 transition-colors">
                <td className="px-2.5 py-2 font-mono text-ink2 whitespace-nowrap">{v.label}</td>
                <td className="px-2.5 py-2 text-faint whitespace-nowrap">{v.applied_at ?? "—"}</td>
                <td className="px-2.5 py-2 font-mono text-emerald-400">{v.tp.toLocaleString()}</td>
                <td className="px-2.5 py-2 font-mono text-red-400">{v.fp.toLocaleString()}</td>
                <td className="px-2.5 py-2 font-mono text-blue-400">{v.tn.toLocaleString()}</td>
                <td className="px-2.5 py-2 font-mono text-amber-400">{v.fn.toLocaleString()}</td>
                <td className="px-2.5 py-2 font-mono text-ink2">{v.total.toLocaleString()}</td>
                <td className="px-2.5 py-2 font-mono text-ink2">{acc !== null ? `${acc.toFixed(1)}%` : "—"}</td>
                <td className="px-2.5 py-2 font-mono text-ink2">{fpr !== null ? `${fpr.toFixed(1)}%` : "—"}</td>
                <td className={`px-2.5 py-2 font-mono font-semibold ${f1Cls}`}>{f1 !== null ? f1.toFixed(3) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PerformanceTable({ perfs }: { perfs: CustomerPerf[] }) {
  const [group, setGroup] = useState<TableGroup>("customer");

  const withData = useMemo(() => perfs.filter((p) => p.versions.some((v) => v.total > 0)), [perfs]);

  // 버전별 그룹: 버전(소문자) → 고객사별 행 + 적용일
  const byVersion = useMemo(() => {
    const map = new Map<string, { version: string; applied_at: string | null; rows: StatRow[] }>();
    for (const p of perfs)
      for (const v of p.versions) {
        if (v.total === 0) continue;
        const key = v.prompt_version.toLowerCase();
        if (!map.has(key)) map.set(key, { version: v.prompt_version, applied_at: v.applied_at, rows: [] });
        const g = map.get(key)!;
        if (v.applied_at && (!g.applied_at || v.applied_at < g.applied_at)) g.applied_at = v.applied_at;
        g.rows.push({ label: p.name, applied_at: null, tp: v.tp, fp: v.fp, tn: v.tn, fn: v.fn, total: v.total });
      }
    return [...map.values()].sort((a, b) => {
      if (a.version === "미지정") return 1;
      if (b.version === "미지정") return -1;
      return String(a.applied_at ?? "").localeCompare(String(b.applied_at ?? "")) || a.version.localeCompare(b.version);
    });
  }, [perfs]);

  if (withData.length === 0) return null;

  return (
    <div className="bg-panel border border-line rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider">
          {group === "customer" ? "고객사별 프롬프트 버전 탐지 성능" : "프롬프트 버전별 탐지 성능"}
        </h3>
        <div className="flex rounded-lg overflow-hidden border border-line2 text-xs">
          {([
            { v: "customer", label: "고객사별" },
            { v: "version",  label: "버전별" },
          ] as { v: TableGroup; label: string }[]).map(({ v, label }) => (
            <button
              key={v}
              onClick={() => setGroup(v)}
              className={`px-3 py-1.5 transition-colors ${
                group === v ? "bg-indigo-700 text-white" : "text-muted hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {group === "customer" ? (
        <div className="space-y-5">
          {withData.map((p) => (
            <div key={p.id} className="space-y-2">
              <span className="text-sm font-medium text-gray-200">{p.name}</span>
              <StatTable
                headLabel="프롬프트 버전"
                rows={p.versions.filter((v) => v.total > 0).map((v) => ({
                  label: v.prompt_version, applied_at: v.applied_at,
                  tp: v.tp, fp: v.fp, tn: v.tn, fn: v.fn, total: v.total,
                }))}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {byVersion.map((g) => {
            // 다중 고객사면 통합 행을 맨 위에 추가
            const rows: StatRow[] = [...g.rows];
            if (g.rows.length > 1) {
              const sum = g.rows.reduce(
                (s, r) => ({ tp: s.tp + r.tp, fp: s.fp + r.fp, tn: s.tn + r.tn, fn: s.fn + r.fn, total: s.total + r.total }),
                { tp: 0, fp: 0, tn: 0, fn: 0, total: 0 },
              );
              rows.unshift({ label: "통합", applied_at: null, ...sum });
            }
            return (
              <div key={g.version} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-200 font-mono">{g.version}</span>
                  {g.applied_at && <span className="text-[10px] text-faint">적용 {g.applied_at}</span>}
                  {g.rows.length > 1 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800/50">
                      고객사 {g.rows.length}곳
                    </span>
                  )}
                </div>
                <StatTable headLabel="고객사" rows={rows} />
              </div>
            );
          })}
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
        { v: "merged",   label: "통합" },
        { v: "customer", label: "고객사별" },
        { v: "version",  label: "프롬프트별" },
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

function MetricToggle({ value, onChange }: { value: Metric; onChange: (m: Metric) => void }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-line2 text-xs">
      {([
        { v: "tpfp", label: "정탐·오탐" },
        { v: "fp",   label: "오탐" },
        { v: "fn",   label: "미탐" },
      ] as { v: Metric; label: string }[]).map(({ v, label }) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-3 py-1.5 transition-colors ${
            value === v ? "bg-rose-700 text-white" : "text-muted hover:text-white"
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
      <input type="date" value={range.to} onChange={(e) => onChange({ ...range, to: e.target.value })} className={cls} />
    </div>
  );
}

function MultiSelect({
  label, options, selected, onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
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

  const all      = selected.length === options.length && options.length > 0;
  const btnLabel = all ? `${label} 전체` : `${label} ${selected.length}/${options.length}`;

  const toggleAll = useCallback(
    (checked: boolean) => onChange(checked ? options.map((o) => o.value) : []),
    [options, onChange],
  );

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
            <input type="checkbox" checked={all} onChange={(e) => toggleAll(e.target.checked)} className="accent-cyan-500" />
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
