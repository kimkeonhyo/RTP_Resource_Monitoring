"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { startOfWeek, addWeeks, format, differenceInCalendarWeeks } from "date-fns";
import {
  ResultModal, statusColor, statusInfo, fmtDate, today,
  type Inspection, type Shipment,
} from "./inspection-list";

type GroupBy = "inspector" | "customer";

const WEEK_OPTS = { weekStartsOn: 1 as const };
const toDate = (s: string) => new Date(`${fmtDate(s)}T12:00:00`);

export default function MaintenanceTimeline() {
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [shipments, setShipments]     = useState<Shipment[]>([]);
  const [groupBy, setGroupBy]         = useState<GroupBy>("inspector");
  const [customerFilter, setCustomerFilter] = useState("");
  const [resultTarget, setResultTarget]     = useState<Inspection | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/maintenance/inspections");
    const d = await r.json() as { inspections: Inspection[] };
    setInspections(d.inspections ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch("/api/maintenance/shipments").then((r) => r.json())
      .then((d: { shipments: Shipment[] }) => setShipments(d.shipments ?? [])).catch(() => {});
  }, []);

  const customers = useMemo(
    () => [...new Set(inspections.map((i) => i.customer_name))].sort((a, b) => a.localeCompare(b, "ko")),
    [inspections],
  );

  const list = useMemo(
    () => (customerFilter ? inspections.filter((i) => i.customer_name === customerFilter) : inspections),
    [inspections, customerFilter],
  );

  // 주 컬럼 범위 — 데이터 최소~최대 + 미래 8주 확보, 최대 26주 cap
  const weeks = useMemo(() => {
    const t = toDate(today());
    const dates = list.map((i) => toDate(i.scheduled_date));
    const min = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()), t.getTime())) : t;
    const maxData = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : t;
    const end = new Date(Math.max(maxData.getTime(), addWeeks(t, 8).getTime()));
    const start = startOfWeek(min, WEEK_OPTS);
    let count = differenceInCalendarWeeks(startOfWeek(end, WEEK_OPTS), start, WEEK_OPTS) + 1;
    count = Math.min(Math.max(count, 1), 26);
    return Array.from({ length: count }, (_, i) => addWeeks(start, i));
  }, [list]);

  const weekStart = weeks[0];

  // 그룹 → 주차index → 점검 목록
  const grouped = useMemo(() => {
    const m = new Map<string, Map<number, Inspection[]>>();
    for (const i of list) {
      const key = groupBy === "inspector" ? (i.inspector || "미지정") : i.customer_name;
      const wk = differenceInCalendarWeeks(toDate(i.scheduled_date), weekStart, WEEK_OPTS);
      if (wk < 0 || wk >= weeks.length) continue;
      if (!m.has(key)) m.set(key, new Map());
      const row = m.get(key)!;
      if (!row.has(wk)) row.set(wk, []);
      row.get(wk)!.push(i);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "ko"));
  }, [list, groupBy, weekStart, weeks.length]);

  const todayWk = differenceInCalendarWeeks(toDate(today()), weekStart, WEEK_OPTS);

  return (
    <div className="space-y-3">
      {/* 툴바 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-line2 text-xs">
            {([{ v: "inspector", label: "점검자별" }, { v: "customer", label: "고객사별" }] as { v: GroupBy; label: string }[]).map(({ v, label }) => (
              <button key={v} onClick={() => setGroupBy(v)} className={`px-3 py-1.5 transition-colors ${groupBy === v ? "bg-cyan-700 text-white" : "text-muted hover:text-white"}`}>{label}</button>
            ))}
          </div>
          <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} className="bg-input border border-line2 rounded-lg px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-cyan-600">
            <option value="">전체 고객사</option>
            {customers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {grouped.length === 0 ? (
        <p className="text-xs text-faint py-10 text-center">표시할 점검 일정이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="border-collapse" style={{ minWidth: "max-content" }}>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-panel border-b border-r border-line px-3 py-2 text-left text-[11px] text-muted font-medium w-40">
                  {groupBy === "inspector" ? "점검자" : "고객사"}
                </th>
                {weeks.map((w, i) => (
                  <th key={i} className={`border-b border-line px-2 py-2 text-[10px] font-medium whitespace-nowrap w-28 ${i === todayWk ? "text-cyan-400" : "text-faint"}`}>
                    {format(w, "M/d")}{i === todayWk ? " ·이번주" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map(([group, row]) => (
                <tr key={group} className="align-top">
                  <td className="sticky left-0 z-10 bg-panel border-b border-r border-line px-3 py-2 text-xs text-ink2 font-medium w-40">{group}</td>
                  {weeks.map((_, wk) => (
                    <td key={wk} className={`border-b border-line px-1.5 py-1.5 align-top w-28 ${wk === todayWk ? "bg-cyan-500/5" : ""}`}>
                      <div className="space-y-1">
                        {(row.get(wk) ?? []).map((insp) => {
                          const si = statusInfo(insp);
                          return (
                            <button
                              key={insp.id}
                              onClick={() => setResultTarget(insp)}
                              title={`${insp.customer_name} · ${insp.inspection_name} · ${fmtDate(insp.scheduled_date)} (${si.label})`}
                              className="block w-full text-left rounded px-1.5 py-1 text-[10px] leading-tight text-white hover:opacity-90 transition-opacity"
                              style={{ backgroundColor: statusColor(insp) }}
                            >
                              <span className="font-mono opacity-90">{fmtDate(insp.scheduled_date).slice(5)}</span>{" "}
                              {groupBy === "inspector" ? insp.customer_name : insp.inspector || "—"}
                              <span className="block opacity-90">{insp.inspection_name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {resultTarget && (
        <ResultModal
          inspection={resultTarget}
          shipment={shipments.find((s) => s.shipment_id === resultTarget.shipment_id) ?? null}
          onClose={() => setResultTarget(null)}
          onSaved={() => { setResultTarget(null); load(); }}
        />
      )}
    </div>
  );
}
