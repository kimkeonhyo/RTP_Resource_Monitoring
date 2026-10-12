"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { InspectionEditor, fmtDate, statusInfo, type Inspection, type Shipment } from "./inspection-list";

/** 점검 상세 전용 페이지 — 팝업과 동일한 InspectionEditor를 전체 화면으로 재사용. */
export default function InspectionDetailPage({ id }: { id: number }) {
  const router = useRouter();
  const [insp, setInsp] = useState<Inspection | null | undefined>(undefined);
  const [shipment, setShipment] = useState<Shipment | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/maintenance/inspections/${id}`, { cache: "no-store" });
    setInsp(r.ok ? (await r.json()).inspection ?? null : null);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // 연결 납품(사양/IMS) 로드
  useEffect(() => {
    if (!insp?.shipment_id) { setShipment(null); return; }
    fetch("/api/maintenance/shipments")
      .then((r) => r.json())
      .then((d: { shipments: Shipment[] }) => setShipment((d.shipments ?? []).find((s) => s.shipment_id === insp.shipment_id) ?? null))
      .catch(() => setShipment(null));
  }, [insp?.shipment_id]);

  if (insp === undefined) return <div className="p-6 text-xs text-faint animate-pulse">불러오는 중…</div>;
  if (insp === null) {
    return (
      <div className="p-6 text-xs text-faint">
        점검을 찾을 수 없습니다. <Link href="/maintenance" className="text-cyan-400 hover:text-cyan-300">← 유지보수 목록</Link>
      </div>
    );
  }

  const si = statusInfo(insp);
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-ink">{insp.customer_name} · {insp.inspection_name}</h1>
          <p className="text-xs text-faint mt-0.5">
            점검예정일 {fmtDate(insp.scheduled_date)}
            <span className={`ml-2 inline-flex px-2 py-0.5 rounded text-[11px] font-medium border ${si.cls}`}>{si.label}</span>
          </p>
        </div>
        <Link href="/maintenance" className="text-xs text-faint hover:text-ink whitespace-nowrap">← 유지보수 목록</Link>
      </div>
      <div className="rounded-xl border border-line bg-input/20 p-4">
        <InspectionEditor inspection={insp} shipment={shipment} onSaved={load} onCancel={() => router.push("/maintenance")} />
      </div>
    </div>
  );
}
