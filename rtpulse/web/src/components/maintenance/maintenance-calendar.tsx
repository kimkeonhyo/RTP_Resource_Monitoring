"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import type { DateClickArg } from "@fullcalendar/interaction";
import type { EventClickArg } from "@fullcalendar/core";
import {
  RegisterModal, ResultModal, statusColor, fmtDate,
  type Inspection, type Shipment,
} from "./inspection-list";

export default function MaintenanceCalendar() {
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [shipments, setShipments]     = useState<Shipment[]>([]);
  const [customerFilter, setCustomerFilter] = useState("");
  const [registerDate, setRegisterDate]     = useState<string | null>(null);
  const [resultTarget, setResultTarget]     = useState<Inspection | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/maintenance/inspections");
    const d = await r.json() as { inspections: Inspection[] };
    setInspections(d.inspections ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/maintenance/shipments")
      .then((r) => r.json())
      .then((d: { shipments: Shipment[] }) => setShipments(d.shipments ?? []))
      .catch(() => {});
  }, []);

  const customers = useMemo(() => {
    const set = new Set<string>();
    shipments.forEach((s) => s.customer_name && set.add(s.customer_name));
    inspections.forEach((i) => set.add(i.customer_name));
    return [...set].sort((a, b) => a.localeCompare(b, "ko"));
  }, [shipments, inspections]);

  const events = useMemo(() => {
    const list = customerFilter ? inspections.filter((i) => i.customer_name === customerFilter) : inspections;
    return list.map((i) => ({
      id: String(i.id),
      title: `${i.customer_name} · ${i.inspection_name}`,
      start: fmtDate(i.scheduled_date),
      allDay: true,
      backgroundColor: statusColor(i),
      borderColor: statusColor(i),
      extendedProps: { insp: i },
    }));
  }, [inspections, customerFilter]);

  const onEventClick = (arg: EventClickArg) => {
    const insp = arg.event.extendedProps.insp as Inspection;
    if (insp) setResultTarget(insp);
  };
  const onDateClick = (arg: DateClickArg) => setRegisterDate(arg.dateStr);

  return (
    <div className="space-y-3">
      {/* 툴바 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3 text-xs">
          <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} className="bg-input border border-line2 rounded-lg px-3 py-1.5 text-ink focus:outline-none focus:border-cyan-600">
            <option value="">전체 고객사</option>
            {customers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="flex items-center gap-2 text-faint">
            <Legend color="#2563eb" label="예정" /><Legend color="#d97706" label="지연" />
            <Legend color="#16a34a" label="완료" /><Legend color="#dc2626" label="취소" />
          </span>
        </div>
        <button onClick={() => setRegisterDate(fmtDate(new Date().toISOString()))} className="px-3 py-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded-lg transition-colors">
          + 점검 등록
        </button>
      </div>

      <div className="bg-panel border border-line rounded-xl p-3">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          locale="ko"
          firstDay={1}
          headerToolbar={{ left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,listMonth" }}
          buttonText={{ today: "오늘", month: "월", week: "주", list: "목록" }}
          events={events}
          height="auto"
          dayMaxEvents={3}
          eventClick={onEventClick}
          dateClick={onDateClick}
          eventDisplay="block"
        />
      </div>

      {registerDate && (
        <RegisterModal
          customers={customers}
          shipments={shipments}
          defaultDate={registerDate}
          defaultCustomer={customerFilter || undefined}
          onClose={() => setRegisterDate(null)}
          onSaved={() => { setRegisterDate(null); load(); }}
        />
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

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
