"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  INSPECTION_NAMES, CUSTOM_INSPECTION_NAME, CYCLES, DEFAULT_CYCLE, NEXT_DEFAULT, PRODUCT_OPTIONS, nextDate, emptyReport,
  INSPECT_TYPES, CHECK_RESULTS, defaultChecklist, EVENT_STATS_QUERY_EXAMPLE, DEFAULT_VMS_IMAGES,
  emptyDetectionStats, normalizeDetectionStats, formatDetectionDate, DETECTION_UNITS,
  type Cycle, type InspectionReport, type SpecRow,
  type InspectType, type CheckItem, type CheckResult, type ImageVersion, type DetectionStats, type DetectionUnit,
} from "@/lib/maintenance";
import { exportInspectionXlsx } from "@/lib/inspection-xlsx";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Inspection {
  id: number;
  customer_name: string;
  shipment_id: string | null;
  inspection_name: string;
  cycle: string | null;
  scheduled_date: string;
  completed_date: string | null;
  status: string;
  inspector: string;
  purpose: string;
  report: InspectionReport;
  next_id: number | null;
  created_at: string;
}

export interface Shipment {
  shipment_id: string;
  customer_name: string;
  title: string;
  status: string;
  delivery_date: string | null;
  shipped_at: string | null;
  confirmed_at: string | null;
  install_date: string | null;   // 최초 설치일 (shipped_at → delivery_date)
  product_names: string | null;  // 출하 품목명
  units: ShipmentUnit[];         // 항목별 사양(시리얼 태그)
  service?: string | null;         // 서비스 (VMS/EDGE/ETC)
  deploy_mode?: string | null;     // 배포 방식 (BUNDLE/MANUAL)
  bundle_version?: string | null;  // 번들 버전 (배포방식 BUNDLE)
  images?: ImageVersion[];         // 서비스 이미지 버전 (IMS)
}

/** 번들 릴리즈 정보 (배포방식 BUNDLE) */
interface VmsBundle {
  name: string;
  appliedSites: string[];
  components: Record<string, string>;
}

export interface ShipmentUnit {
  item_name: string;
  serial_no: string | null;
  tags: Record<string, string> | null;
}

/** 출하 유닛 목록 → 항목별 사양 행(제품/S/N/태그) */
function unitsToSpecs(units: ShipmentUnit[] | undefined): SpecRow[] {
  if (!units || units.length === 0) return [];
  return units.map((u) => ({
    name: u.item_name ?? "",
    serial: u.serial_no ?? "",
    tags: u.tags ?? {},
  }));
}

/** 사양 행들에서 태그 컬럼(키) 목록을 추출 (등장 순서 유지) */
function specColumns(rows: SpecRow[]): string[] {
  const seen: string[] = [];
  for (const r of rows) for (const k of Object.keys(r.tags ?? {})) if (!seen.includes(k)) seen.push(k);
  return seen;
}

/** 고객명 아래 표시할 서버/워크스테이션 사양(납품 품목) 읽기 전용 표 */
function CustomerSpec({ units }: { units: ShipmentUnit[] }) {
  if (!units || units.length === 0) {
    return <p className="text-[11px] text-faint pl-1">납품 품목(사양) 정보 없음</p>;
  }
  const cols = specColumns(units.map((u) => ({ name: "", serial: "", tags: u.tags ?? {} })));
  return (
    <div className="overflow-x-auto rounded-lg border border-line/70 bg-input/20">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[10px] text-faint">
            <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">제품</th>
            <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">S/N</th>
            {cols.map((c) => <th key={c} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">{c}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {units.map((u, i) => (
            <tr key={i}>
              <td className="px-2 py-1 text-ink2 whitespace-nowrap">{u.item_name || "—"}</td>
              <td className="px-2 py-1 font-mono text-faint whitespace-nowrap">{u.serial_no ?? "—"}</td>
              {cols.map((c) => <td key={c} className="px-2 py-1 text-ink2 whitespace-nowrap">{(u.tags ?? {})[c] ?? "—"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const today = () => new Date().toISOString().slice(0, 10);
/** ISO/타임스탬프 문자열을 YYYY-MM-DD로 표시 */
export const fmtDate = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : "—");

export function statusInfo(insp: Inspection): { label: string; cls: string } {
  if (insp.status === "완료") return { label: "완료", cls: "bg-green-900/40 text-green-300 border-green-700/50" };
  if (insp.status === "취소") return { label: "취소", cls: "bg-red-900/40 text-red-300 border-red-700/50" };
  if (fmtDate(insp.scheduled_date) < today()) return { label: "지연", cls: "bg-amber-900/40 text-amber-300 border-amber-700/50" };
  return { label: "예정", cls: "bg-blue-900/40 text-blue-300 border-blue-700/50" };
}

/** FullCalendar 이벤트 배경색 (상태별) */
export function statusColor(insp: Inspection): string {
  if (insp.status === "완료") return "#16a34a"; // green
  if (insp.status === "취소") return "#dc2626"; // red
  if (fmtDate(insp.scheduled_date) < today()) return "#d97706"; // amber (지연)
  return "#2563eb"; // blue (예정)
}

const inputCls = "w-full bg-input border border-line2 rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-cyan-600";

/** 고객사 한 줄 사양 요약 (접힘 상태) */
function specSummary(units: ShipmentUnit[]): string {
  if (!units || units.length === 0) return "납품 품목 없음";
  const u = units[0];
  const parts = [u.item_name, u.tags?.CPU, u.tags?.RAM].filter(Boolean);
  let s = parts.join(" · ") || "—";
  if (units.length > 1) s += `  외 ${units.length - 1}대`;
  return s;
}

// ─── 고객사 아코디언 (접기/펼치기) ──────────────────────────────────────────────

function CustomerAccordion({
  customer, units, items, shipments, activeVersion, onRegister, onDelete, onReload,
}: {
  customer: string;
  units: ShipmentUnit[];
  items: Inspection[];
  shipments: Shipment[];
  activeVersion?: string;
  onRegister: () => void;
  onDelete: (id: number) => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [openInsp, setOpenInsp] = useState<number | null>(null); // 인라인 펼친 점검 id

  // 상태별 건수 + 가장 가까운 예정일
  const counts = useMemo(() => {
    const c = { 예정: 0, 지연: 0, 완료: 0, 취소: 0 } as Record<string, number>;
    for (const i of items) c[statusInfo(i).label] = (c[statusInfo(i).label] ?? 0) + 1;
    return c;
  }, [items]);
  const nextUpcoming = useMemo(
    () => items.filter((i) => i.status === "예정").sort((a, b) => fmtDate(a.scheduled_date).localeCompare(fmtDate(b.scheduled_date)))[0],
    [items],
  );

  return (
    <div className="rounded-lg border border-line bg-input/20">
      {/* 헤더 (요약) — 클릭 시 펼침 */}
      <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none" onClick={() => setOpen((o) => !o)}>
        <svg className={`w-3.5 h-3.5 shrink-0 text-faint transition-transform ${open ? "" : "-rotate-90"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        <span className="text-sm font-medium text-gray-200 shrink-0">{customer}</span>
        <span className="text-[11px] text-faint truncate min-w-0">{specSummary(units)}</span>
        {activeVersion && (
          <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-900/40 text-purple-300 border border-purple-700/50 whitespace-nowrap" title="현재 사용 중인 프롬프트 버전">
            프롬프트 {activeVersion}
          </span>
        )}
        <span className="flex-1 min-w-0" />

        {/* 상태 배지 */}
        <div className="flex items-center gap-1 shrink-0">
          {counts["지연"] > 0 && <Badge n={counts["지연"]} label="지연" cls="bg-amber-900/40 text-amber-300 border-amber-700/50" />}
          {counts["예정"] > 0 && <Badge n={counts["예정"]} label="예정" cls="bg-blue-900/40 text-blue-300 border-blue-700/50" />}
          {counts["완료"] > 0 && <Badge n={counts["완료"]} label="완료" cls="bg-green-900/40 text-green-300 border-green-700/50" />}
          {items.length === 0 && <span className="text-[10px] text-faint">점검 없음</span>}
          {nextUpcoming && <span className="text-[10px] text-faint font-mono ml-1 hidden sm:inline">다음 {fmtDate(nextUpcoming.scheduled_date)}</span>}
        </div>
        <button onClick={(e) => { e.stopPropagation(); onRegister(); }} className="shrink-0 text-xs text-cyan-400 hover:text-cyan-300 ml-1">+ 점검 등록</button>
      </div>

      {/* 본문 (펼침) */}
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-line/60 pt-3">
          <CustomerSpec units={units} />
          {items.length === 0 ? (
            <p className="text-[11px] text-faint pl-1">등록된 점검이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-input/70 text-[10px] text-muted uppercase tracking-wider">
                    {["", "점검명", "점검예정일", "주기", "상태", "점검자", "등록일", ""].map((h, i) => (
                      <th key={i} className="px-2.5 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {items.map((insp) => {
                    const si = statusInfo(insp);
                    const expanded = openInsp === insp.id;
                    const toggle = () => setOpenInsp((id) => (id === insp.id ? null : insp.id));
                    return (
                      <Fragment key={insp.id}>
                        <tr className={`hover:bg-input/30 transition-colors cursor-pointer ${expanded ? "bg-input/30" : ""}`} onClick={toggle}>
                          <td className="px-2 py-2 w-6">
                            <svg className={`w-3.5 h-3.5 text-faint transition-transform ${expanded ? "" : "-rotate-90"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                            </svg>
                          </td>
                          <td className="px-2.5 py-2 text-ink2 whitespace-nowrap">{insp.inspection_name}</td>
                          <td className="px-2.5 py-2 font-mono text-faint whitespace-nowrap">{fmtDate(insp.scheduled_date)}</td>
                          <td className="px-2.5 py-2 text-faint">{insp.cycle ?? "—"}</td>
                          <td className="px-2.5 py-2"><span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium border ${si.cls}`}>{si.label}</span></td>
                          <td className="px-2.5 py-2 text-muted">{insp.inspector || "—"}</td>
                          <td className="px-2.5 py-2 font-mono text-faint whitespace-nowrap">{fmtDate(insp.created_at)}</td>
                          <td className="px-2.5 py-2 whitespace-nowrap text-right">
                            <Link href={`/maintenance/${insp.id}`} onClick={(e) => e.stopPropagation()} className="text-faint hover:text-cyan-400 mr-3" title="전체 페이지로 열기">페이지</Link>
                            <button onClick={(e) => { e.stopPropagation(); onDelete(insp.id); }} className="text-faint hover:text-red-400">삭제</button>
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={8} className="px-3 py-3 bg-input/10 border-t border-line/60">
                              <InspectionEditor
                                inspection={insp}
                                shipment={shipments.find((s) => s.shipment_id === insp.shipment_id) ?? null}
                                onSaved={onReload}
                                onCancel={() => setOpenInsp(null)}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Badge({ n, label, cls }: { n: number; label: string; cls: string }) {
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>{label} {n}</span>;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function InspectionList() {
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [shipments, setShipments]     = useState<Shipment[]>([]);
  const [shipErr, setShipErr]         = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [customerFilter, setCustomerFilter] = useState("");
  const [registerFor, setRegisterFor]       = useState<string | null>(null); // null=닫힘, ""=일반, "고객사"=프리필
  const [activeVersions, setActiveVersions] = useState<Record<string, string>>({}); // 고객사명 → 사용 중 프롬프트 버전

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/maintenance/inspections");
      const d = await r.json() as { inspections: Inspection[] };
      setInspections(d.inspections ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/maintenance/shipments")
      .then((r) => r.json())
      .then((d: { shipments: Shipment[]; error?: string }) => {
        setShipments(d.shipments ?? []);
        if (d.error) setShipErr(d.error);
      })
      .catch(() => setShipErr("납품현황을 불러오지 못했습니다."));
  }, []);

  // data-watch 프롬프트 사용현황(active) → 고객사명 → 버전 맵 구성
  useEffect(() => {
    fetch("/api/prompt-history/active")
      .then((r) => r.json())
      .then((m: Record<string, string[]>) => {
        const inv: Record<string, string> = {};
        for (const [ver, names] of Object.entries(m)) for (const n of names) inv[n] = ver;
        setActiveVersions(inv);
      })
      .catch(() => {});
  }, []);

  // 고객사 목록 = 납품현황 + 점검에 등장한 고객사 합집합
  const customers = useMemo(() => {
    const set = new Set<string>();
    shipments.forEach((s) => s.customer_name && set.add(s.customer_name));
    inspections.forEach((i) => set.add(i.customer_name));
    return [...set].sort((a, b) => a.localeCompare(b, "ko"));
  }, [shipments, inspections]);

  // 고객사별 점검 그룹 (예정일 순 정렬)
  const inspByCustomer = useMemo(() => {
    const m = new Map<string, Inspection[]>();
    for (const i of inspections) {
      if (!m.has(i.customer_name)) m.set(i.customer_name, []);
      m.get(i.customer_name)!.push(i);
    }
    for (const arr of m.values()) arr.sort((a, b) => fmtDate(a.scheduled_date).localeCompare(fmtDate(b.scheduled_date)));
    return m;
  }, [inspections]);

  // 고객사별 납품 품목(사양) — 중복(제품+S/N) 제거
  const unitsByCustomer = useMemo(() => {
    const m = new Map<string, ShipmentUnit[]>();
    for (const s of shipments) {
      if (!s.customer_name) continue;
      const arr = m.get(s.customer_name) ?? [];
      for (const u of s.units ?? []) {
        const key = `${u.item_name}|${u.serial_no ?? ""}`;
        if (!arr.some((x) => `${x.item_name}|${x.serial_no ?? ""}` === key)) arr.push(u);
      }
      m.set(s.customer_name, arr);
    }
    return m;
  }, [shipments]);

  // 납품된 고객사 전부 노출 (점검 0건이어도). 필터 적용.
  const customersToShow = useMemo(
    () => (customerFilter ? customers.filter((c) => c === customerFilter) : customers),
    [customers, customerFilter],
  );

  const stats = useMemo(() => {
    const total = inspections.length;
    const done = inspections.filter((i) => i.status === "완료").length;
    const overdue = inspections.filter((i) => i.status === "예정" && i.scheduled_date < today()).length;
    const upcoming = inspections.filter((i) => i.status === "예정" && i.scheduled_date >= today()).length;
    return { total, done, overdue, upcoming };
  }, [inspections]);

  const handleDelete = async (id: number) => {
    if (!confirm("이 점검 일정을 삭제하시겠습니까?")) return;
    await fetch(`/api/maintenance/inspections/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="space-y-4">
      {/* 통계 카드 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: "전체", value: stats.total, cls: "text-ink" },
          { label: "예정", value: stats.upcoming, cls: "text-blue-400" },
          { label: "지연", value: stats.overdue, cls: "text-amber-400" },
          { label: "완료", value: stats.done, cls: "text-green-400" },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-line bg-input/40 px-4 py-3">
            <div className="text-xs text-faint">{c.label}</div>
            <div className={`mt-1 text-2xl font-semibold ${c.cls}`}>{c.value}<span className="ml-1 text-xs text-faint font-normal">건</span></div>
          </div>
        ))}
      </div>

      {/* 툴바 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} className="bg-input border border-line2 rounded-lg px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-cyan-600">
            <option value="">전체 고객사</option>
            {customers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {shipErr && <span className="text-xs text-amber-500/80">⚠ {shipErr}</span>}
        </div>
        <button onClick={() => setRegisterFor("")} className="px-3 py-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded-lg transition-colors">
          + 점검 등록
        </button>
      </div>

      {/* 리스트 — 납품 고객사 전부 노출 */}
      {loading ? (
        <p className="text-xs text-faint py-10 text-center animate-pulse">불러오는 중…</p>
      ) : customersToShow.length === 0 ? (
        <p className="text-xs text-faint py-10 text-center">납품 고객사가 없습니다. [+ 점검 등록]으로 직접 추가할 수 있습니다.</p>
      ) : (
        <div className="space-y-2">
          {customersToShow.map((customer) => (
            <CustomerAccordion
              key={customer}
              customer={customer}
              units={unitsByCustomer.get(customer) ?? []}
              items={inspByCustomer.get(customer) ?? []}
              shipments={shipments}
              activeVersion={activeVersions[customer]}
              onRegister={() => setRegisterFor(customer)}
              onDelete={handleDelete}
              onReload={load}
            />
          ))}
        </div>
      )}

      {registerFor !== null && (
        <RegisterModal
          customers={customers}
          shipments={shipments}
          defaultCustomer={registerFor || undefined}
          onClose={() => setRegisterFor(null)}
          onSaved={() => { setRegisterFor(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── 점검 등록 모달 ─────────────────────────────────────────────────────────────

export function RegisterModal({
  customers, shipments, onClose, onSaved, defaultDate, defaultCustomer,
}: {
  customers: string[];
  shipments: Shipment[];
  onClose: () => void;
  onSaved: () => void;
  defaultDate?: string;       // 달력 날짜 클릭 시 예정일 프리필
  defaultCustomer?: string;   // 고객사 프리필
}) {
  const [form, setForm] = useState({
    customer_name: defaultCustomer ?? "",
    shipment_id: "" as string,
    inspection_name: "초기점검",
    cycle: DEFAULT_CYCLE["초기점검"] as Cycle,
    scheduled_date: defaultDate || today(),
    inspector: "",
    purpose: "",
  });
  const [customName, setCustomName] = useState("");   // "기타" 선택 시 직접 입력할 점검명
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // 고객사 선택 시 해당 납품(설치)일을 기본 예정일 힌트로
  const custShipments = shipments.filter((s) => s.customer_name === form.customer_name);
  const isCustomName = form.inspection_name === CUSTOM_INSPECTION_NAME;

  const setName = (name: string) =>
    setForm((f) => ({ ...f, inspection_name: name, cycle: DEFAULT_CYCLE[name] ?? f.cycle }));

  const submit = async () => {
    if (!form.customer_name.trim()) { setErr("고객사를 선택/입력하세요."); return; }
    if (isCustomName && !customName.trim()) { setErr("점검명을 직접 입력하세요."); return; }
    if (!form.scheduled_date) { setErr("예정일을 입력하세요."); return; }
    setSaving(true); setErr("");
    try {
      // "기타"면 직접 입력한 점검명으로 치환하여 저장.
      const effectiveName = isCustomName ? customName.trim() : form.inspection_name;
      const res = await fetch("/api/maintenance/inspections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, inspection_name: effectiveName, shipment_id: form.shipment_id || null }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? "등록 실패"); }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="점검 일정 등록" onClose={onClose}>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div>
        <label className="block text-xs text-muted mb-1">고객사 *</label>
        <input list="cust-list" value={form.customer_name} onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))} className={inputCls} placeholder="고객사명 (납품현황에서 선택 또는 입력)" />
        <datalist id="cust-list">{customers.map((c) => <option key={c} value={c} />)}</datalist>
      </div>
      {custShipments.length > 0 && (
        <div>
          <label className="block text-xs text-muted mb-1">연결 납품(선택)</label>
          <select value={form.shipment_id} onChange={(e) => setForm((f) => ({ ...f, shipment_id: e.target.value }))} className={inputCls}>
            <option value="">— 없음 —</option>
            {custShipments.map((s) => (
              <option key={s.shipment_id} value={s.shipment_id}>
                {s.shipment_id} · {s.title} {s.confirmed_at ? `(확정 ${String(s.confirmed_at).slice(0,10)})` : s.delivery_date ? `(예정 ${s.delivery_date})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted mb-1">점검명 *</label>
          <select value={form.inspection_name} onChange={(e) => setName(e.target.value)} className={inputCls}>
            {INSPECTION_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {isCustomName && (
            <input value={customName} onChange={(e) => setCustomName(e.target.value)}
              className={`${inputCls} mt-1`} placeholder="점검명 직접 입력" autoFocus />
          )}
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">점검주기</label>
          <select value={form.cycle} onChange={(e) => setForm((f) => ({ ...f, cycle: e.target.value as Cycle }))} className={inputCls}>
            {CYCLES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted mb-1">예정일 *</label>
          <input type="date" value={form.scheduled_date} onChange={(e) => setForm((f) => ({ ...f, scheduled_date: e.target.value }))} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">점검자</label>
          <input value={form.inspector} onChange={(e) => setForm((f) => ({ ...f, inspector: e.target.value }))} className={inputCls} placeholder="점검자 이름" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">목적</label>
        <input value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} className={inputCls} placeholder="점검 목적" />
      </div>
      <ModalActions onClose={onClose} onSubmit={submit} saving={saving} label="등록" />
    </Modal>
  );
}

// ─── 점검 결과 등록 모달 (상세 리포트 + 다음 일정 자동 등록) ─────────────────────

/** 모달 래퍼 (달력/타임라인용) */
export function ResultModal({
  inspection, shipment, onClose, onSaved,
}: {
  inspection: Inspection;
  shipment: Shipment | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isCompleted = inspection.status === "완료";
  return (
    <Modal title={`${isCompleted ? "점검 상세" : "점검 결과 등록"} — ${inspection.customer_name} / ${inspection.inspection_name}`} onClose={onClose} wide>
      <div className="flex justify-end -mt-2">
        <Link href={`/maintenance/${inspection.id}`} className="text-xs text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1" title="전체 페이지로 보기">↗ 전체 페이지로 보기</Link>
      </div>
      <InspectionEditor inspection={inspection} shipment={shipment} onSaved={onSaved} onCancel={onClose} />
    </Modal>
  );
}

/** 점검 상세 편집기 — 인라인/모달 공용. 완료 건은 읽기→수정 토글. */
export function InspectionEditor({
  inspection, shipment, onSaved, onCancel,
}: {
  inspection: Inspection;
  shipment: Shipment | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isCompleted = inspection.status === "완료";
  const [editing, setEditing] = useState(!isCompleted); // 미완료는 바로 편집, 완료는 읽기
  const schedDate = inspection.scheduled_date ? String(inspection.scheduled_date).slice(0, 10) : today();

  // 기존 리포트 우선, 비어있으면 연결 납품에서 최초설치일·점검일·항목별 사양 자동 채움.
  // 구버전 리포트(specs 구조 변경 전) 호환을 위해 specs 행을 {name,serial,tags}로 정규화.
  const [report, setReport] = useState<InspectionReport>(() => {
    const base = inspection.report && inspection.report.env ? inspection.report : emptyReport();
    const rawSpecs = (base.specs && base.specs.length > 0) ? base.specs : unitsToSpecs(shipment?.units);
    const specs: SpecRow[] = (rawSpecs as Partial<SpecRow>[]).map((s) => ({
      name:   s?.name   ?? "",
      serial: s?.serial ?? "",
      tags:   (s?.tags && typeof s.tags === "object") ? s.tags : {},
    }));
    const inspType: InspectType = base.env?.inspect_type ?? "remote";
    const checklist = (base.checklist && base.checklist.length > 0)
      ? base.checklist.map((c) => ({ ...c }))
      : defaultChecklist(inspType);
    // VMS 이미지 버전: 기존 리포트 우선, 없으면 연결 납품(IMS) 서비스 이미지로 프리필
    const images: ImageVersion[] = (base.images && base.images.length > 0)
      ? base.images.map((i) => ({ ...i }))
      : (shipment?.images ?? []).map((i) => ({ ...i }));
    return {
      env: {
        install_date:    base.env?.install_date || (shipment?.install_date ?? ""),
        inspect_date:    base.env?.inspect_date || schedDate,
        product_name:    base.env?.product_name ?? (shipment?.service ?? ""),
        product_version: base.env?.product_version ?? "",
        inspect_type:    inspType,
      },
      specs,
      checklist,
      detectionStats: normalizeDetectionStats(base.detectionStats),
      complaints: base.complaints ?? "",
      images,
      contents:  base.contents  ?? "",
      results:   base.results   ?? "",
      followups: base.followups ?? [],
    };
  });

  const [completedDate, setCompletedDate] = useState(
    inspection.completed_date ? String(inspection.completed_date).slice(0, 10) : today(),
  );
  const [inspector, setInspector] = useState(inspection.inspector ?? "");
  const [purpose, setPurpose] = useState(inspection.purpose ?? "");
  // 다음 점검 자동 등록 — 이미 완료됐거나 다음 점검이 연결돼 있으면 기본 해제(중복 방지)
  const [scheduleNext, setScheduleNext] = useState(!isCompleted && !inspection.next_id);
  const [nextName, setNextName] = useState(NEXT_DEFAULT[inspection.inspection_name] ?? "월간 점검");
  const [nextCustomName, setNextCustomName] = useState("");   // "기타" 선택 시 직접 입력
  const [nextCycle, setNextCycle] = useState<Cycle>(DEFAULT_CYCLE[NEXT_DEFAULT[inspection.inspection_name] ?? "월간 점검"] ?? "1개월");
  const [nextSched, setNextSched] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // IMS 이미지 버전 반영 상태
  const [imsMsg, setImsMsg]   = useState<{ ok: boolean; text: string } | null>(null);
  const [imsBusy, setImsBusy] = useState(false);
  // 이미지별 버전 선택지(드롭다운) — 릴리즈노트/ims
  const [imgOpts, setImgOpts]   = useState<Record<string, string[]>>({});
  // 번들 목록(배포방식 BUNDLE)
  const [bundles, setBundles]   = useState<VmsBundle[]>([]);

  const isVms = report.env.product_name === "VMS";
  // 배포방식: 리포트에 저장된 값 우선, 없으면 연결 납품(IMS)에서
  const deployMode = (report.deploy_mode || shipment?.deploy_mode || "").toUpperCase();
  const isBundle = deployMode === "BUNDLE";

  // ── 체크리스트(2-2) 편집 ────────────────────────────────────────────────
  const setChecklist = (fn: (list: CheckItem[]) => CheckItem[]) =>
    setReport((r) => ({ ...r, checklist: fn(r.checklist ?? []) }));
  const setCheck = (i: number, k: keyof CheckItem, v: string) =>
    setChecklist((list) => list.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)));
  const addCheck = () => setChecklist((list) => [...list, { type: "", item: "", method: "", result: "", action: "", note: "" }]);
  const removeCheck = (i: number) => setChecklist((list) => list.filter((_, idx) => idx !== i));
  const loadDefaultChecklist = (type: InspectType) => {
    const cur = report.checklist ?? [];
    const hasContent = cur.some((c) => c.item || c.result || c.action || c.note);
    if (hasContent && !confirm("현재 체크리스트를 기본 항목으로 교체하시겠습니까?")) return;
    setReport((r) => ({ ...r, checklist: defaultChecklist(type) }));
  };
  // 유형 선택 시 해당 방식(원격/방문) 체크리스트로 교체. 입력이 있으면 확인 후 교체.
  const changeInspectType = (type: InspectType) => {
    if (type === (report.env.inspect_type ?? "remote")) return;
    const cur = report.checklist ?? [];
    const edited = cur.some((c) => c.result || c.action || c.note);
    if (edited && !confirm("검사 방식을 바꾸면 점검 내용이 해당 방식 기본 체크리스트로 교체됩니다. 진행할까요?")) return;
    setReport((r) => ({ ...r, env: { ...r.env, inspect_type: type }, checklist: defaultChecklist(type) }));
  };

  // ── 탐지현황 통계(2-3) — 이벤트×TP/FP×날짜 매트릭스 편집 ──────────────────
  const det: DetectionStats = report.detectionStats ?? emptyDetectionStats();
  const setDet = (fn: (d: DetectionStats) => DetectionStats) =>
    setReport((r) => ({ ...r, detectionStats: fn(r.detectionStats ?? emptyDetectionStats()) }));
  const setDetUnit = (u: DetectionUnit) => setDet((d) => ({ ...d, unit: u }));
  const addDetDate = () => setDet((d) => ({ ...d, dates: [...d.dates, ""], events: d.events.map((e) => ({ ...e, tp: [...e.tp, null], fp: [...e.fp, null] })) }));
  const removeDetDate = (ci: number) => setDet((d) => ({ ...d, dates: d.dates.filter((_, i) => i !== ci), events: d.events.map((e) => ({ ...e, tp: e.tp.filter((_, i) => i !== ci), fp: e.fp.filter((_, i) => i !== ci) })) }));
  const setDetDate = (ci: number, v: string) => setDet((d) => ({ ...d, dates: d.dates.map((x, i) => (i === ci ? v : x)) }));
  const addDetEvent = () => setDet((d) => ({ ...d, events: [...d.events, { name: "", tp: d.dates.map(() => null), fp: d.dates.map(() => null) }] }));
  const removeDetEvent = (ei: number) => setDet((d) => ({ ...d, events: d.events.filter((_, i) => i !== ei) }));
  const setDetName = (ei: number, v: string) => setDet((d) => ({ ...d, events: d.events.map((e, i) => (i === ei ? { ...e, name: v } : e)) }));
  const setDetCell = (ei: number, kind: "tp" | "fp", ci: number, v: string) =>
    setDet((d) => ({ ...d, events: d.events.map((e, i) => (i === ei ? { ...e, [kind]: e[kind].map((x, j) => (j === ci ? (v.trim() === "" ? null : Number(v)) : x)) } : e)) }));
  // 합계 계산
  const sumArr = (a: (number | null)[]) => a.reduce((s: number, n) => s + (n ?? 0), 0);
  const detColTotal = (ci: number) => det.events.reduce((s, e) => s + (e.tp[ci] ?? 0) + (e.fp[ci] ?? 0), 0);
  const detGrandTotal = det.dates.reduce((s, _d, ci) => s + detColTotal(ci), 0);
  const dash = (n: number) => (n ? String(n) : "-");

  // ── VMS 이미지 버전 편집 ────────────────────────────────────────────────
  const images: ImageVersion[] = report.images ?? [];
  const setImages = (fn: (imgs: ImageVersion[]) => ImageVersion[]) =>
    setReport((r) => ({ ...r, images: fn(r.images ?? []) }));
  const setImage = (i: number, k: keyof ImageVersion, v: string) =>
    setImages((imgs) => imgs.map((im, idx) => (idx === i ? { ...im, [k]: v } : im)));
  const addImage = () => setImages((imgs) => [...imgs, { image_name: "", version: "" }]);
  const removeImage = (i: number) => setImages((imgs) => imgs.filter((_, idx) => idx !== i));
  // IMS(ims)에서 VMS 이미지 버전(현재 버전 + 선택지)을 불러온다.
  //  - force=true: 사용자 입력을 덮어쓰고 다시 채움([IMS 이미지 불러오기] 버튼)
  //  - force 미지정: 버전이 비어있을 때만 채움(제품명 VMS 선택 시 자동)
  const loadImsImages = useCallback(async (force = false) => {
    try {
      const q = new URLSearchParams({ customer: inspection.customer_name });
      if (shipment?.shipment_id) q.set("shipment", shipment.shipment_id);
      const res = await fetch(`/api/maintenance/vms-image-versions?${q.toString()}`);
      const d = await res.json() as { current?: ImageVersion[]; options?: Record<string, string[]>; bundles?: VmsBundle[]; deploy_mode?: string | null; bundle_version?: string | null };
      setImgOpts(d.options ?? {});
      setBundles(d.bundles ?? []);
      // 초기 버전은 IMS(current)에서만. IMS에 없으면 버전은 비워두고
      // 사용자가 드롭다운(릴리즈노트)에서 선택하도록 한다. (릴리즈노트 최신본으로 채우지 않음)
      const built: ImageVersion[] =
        (d.current && d.current.length > 0) ? d.current.map((i) => ({ ...i }))
        : (shipment?.images && shipment.images.length > 0) ? shipment.images.map((i) => ({ ...i }))
        : DEFAULT_VMS_IMAGES.map((n) => ({ image_name: n, version: "" }));
      setReport((r) => {
        // 배포방식/번들버전 초기화 — 해석된 IMS 서비스(GET 응답) 값 우선,
        // 없으면 연결 납품 값, 사용자 입력은 보존.
        const nextDeploy = r.deploy_mode || (d.deploy_mode ?? "") || (shipment?.deploy_mode ?? "");
        const nextBundle = r.bundle_version || (d.bundle_version ?? "") || (shipment?.bundle_version ?? "");
        const cur = r.images ?? [];
        const keepImages = !force && cur.some((i) => i.version);
        return {
          ...r,
          deploy_mode: nextDeploy,
          bundle_version: nextBundle,
          images: keepImages ? cur : built,
        };
      });
    } catch { /* ims/Notion 접근 불가 시 무시 — 수동 입력 가능 */ }
  }, [inspection.customer_name, shipment]);

  // 제품명 변경 — VMS 선택 시 IMS 이미지 버전 자동 로드.
  const changeProduct = (v: string) => {
    setEnv("product_name", v);
    if (v === "VMS") loadImsImages(false);
  };

  // 최초 진입 시 이미 제품명이 VMS면 버전/선택지 로드.
  useEffect(() => {
    if (report.env.product_name === "VMS") loadImsImages(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncIms = async () => {
    if (!shipment?.shipment_id) { setImsMsg({ ok: false, text: "연결된 납품(IMS)이 없어 반영할 수 없습니다." }); return; }
    const body: { images?: ImageVersion[]; bundle_version?: string } = {};
    let confirmMsg: string;
    if (isBundle) {
      const bv = (report.bundle_version ?? "").trim();
      if (!bv) { setImsMsg({ ok: false, text: "반영할 번들 버전이 없습니다." }); return; }
      body.bundle_version = bv;
      confirmMsg = `IMS 납품정보(${shipment.shipment_id})의 번들 버전을 '${bv}'(으)로 갱신합니다. 진행할까요?`;
    } else {
      const payload = images.filter((i) => i.image_name.trim());
      if (payload.length === 0) { setImsMsg({ ok: false, text: "반영할 이미지 버전이 없습니다." }); return; }
      body.images = payload;
      confirmMsg = `IMS 납품정보(${shipment.shipment_id})의 이미지 버전 ${payload.length}건을 이 점검 기준으로 갱신합니다. 진행할까요?`;
    }
    if (!confirm(confirmMsg)) return;
    setImsBusy(true); setImsMsg(null);
    try {
      // 연결 납품에 서비스가 없을 수 있어 고객사도 함께 전달(서버가 고객사 최신 VMS 서비스로 폴백).
      const res = await fetch(`/api/maintenance/shipments/${encodeURIComponent(shipment.shipment_id)}/images?customer=${encodeURIComponent(inspection.customer_name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "반영 실패");
      const createdNote = d.service_created ? " · 서비스 신규 생성" : "";
      setImsMsg({ ok: true, text: (isBundle ? `IMS 번들 버전 반영 완료 (${d.bundle_version ?? body.bundle_version})` : `IMS 반영 완료 (수정 ${d.updated ?? 0} · 추가 ${d.inserted ?? 0})`) + createdNote });
    } catch (e) {
      setImsMsg({ ok: false, text: e instanceof Error ? e.message : "반영 실패" });
    } finally {
      setImsBusy(false);
    }
  };

  // 다음 예정일은 "점검 일"(2-1 운영 환경) 기준으로 주기를 더해 계산.
  // 단, 주기가 "없음"(1회성)이면 자동 계산하지 않고 사용자가 직접 입력한 값만 사용한다.
  const baseForNext = report.env.inspect_date || completedDate || today();
  const computedNext = nextCycle === "없음" ? nextSched : (nextSched || nextDate(baseForNext, nextCycle));

  const setEnv = (k: keyof InspectionReport["env"], v: string) =>
    setReport((r) => ({ ...r, env: { ...r.env, [k]: v } }));

  const submit = async (complete: boolean) => {
    setSaving(true); setErr("");
    try {
      const body: Record<string, unknown> = {
        completed_date: completedDate,
        inspector,
        purpose,
        report,
      };
      if (complete) body.status = "완료";  // 완료 처리 시에만 상태 변경 (단순 저장은 상태 유지)
      if (scheduleNext && nextName && nextCycle) {
        // "기타"면 직접 입력한 점검명 사용 — 미입력 시 저장 차단.
        const isNextCustom = nextName === CUSTOM_INSPECTION_NAME;
        if (isNextCustom && !nextCustomName.trim()) {
          setErr("다음 점검명을 직접 입력하세요.");
          setSaving(false);
          return;
        }
        // 주기가 "없음"이면 자동 계산이 없으므로 다음 예정일을 반드시 직접 입력해야 한다.
        if (nextCycle === "없음" && !computedNext) {
          setErr("주기가 '없음'일 때는 다음 예정일을 직접 입력하세요.");
          setSaving(false);
          return;
        }
        const effectiveNextName = isNextCustom ? nextCustomName.trim() : nextName;
        body.next = { inspection_name: effectiveNextName, cycle: nextCycle, scheduled_date: computedNext };
      }
      const res = await fetch(`/api/maintenance/inspections/${inspection.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? "저장 실패"); }
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  };

  const ta = "w-full bg-input border border-line2 rounded-lg px-3 py-2 text-sm text-ink2 focus:outline-none focus:border-cyan-600 resize-y min-h-[4rem]";

  // 완료 건 읽기 전용 보기 (수정 버튼으로 편집 전환)
  if (isCompleted && !editing) {
    const roChecklist = (report.checklist ?? []).filter((c) => c.item);
    const roDet = normalizeDetectionStats(report.detectionStats);
    const roDetHasData = roDet.dates.length > 0 && roDet.events.some((e) => e.name || e.tp.some((n) => n != null) || e.fp.some((n) => n != null));
    const inspTypeLabel = INSPECT_TYPES.find((t) => t.key === (report.env.inspect_type ?? "remote"))?.label ?? "원격 검사";
    return (
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
          <RO label="점검일" value={fmtDate(inspection.completed_date)} />
          <RO label="점검자" value={inspection.inspector || "—"} />
          <RO label="목적" value={inspection.purpose || "—"} />
          <RO label="검사 방식" value={inspTypeLabel} />
          <RO label="최초 설치일" value={report.env.install_date || "—"} />
          <RO label="제품명" value={report.env.product_name || "—"} />
          <RO label="제품버전" value={report.env.product_version || "—"} />
        </div>

        {roChecklist.length > 0 && (
          <ROSection title="2-2. 점검 내용">
            <ChecklistTable rows={roChecklist} readOnly />
          </ROSection>
        )}

        {roDetHasData && (
          <ROSection title="2-3. 탐지현황 통계">
            <DetectionStatsView det={roDet} />
          </ROSection>
        )}

        {report.complaints && <ROBlock label="2-4. 고객민원 및 특이사항" value={report.complaints} />}

        {isVms && isBundle && (report.bundle_version || deployMode) && (
          <ROSection title="VMS 번들 버전">
            <p className="text-xs text-ink2">배포 방식: Bundle · 번들 버전: <span className="font-mono">{report.bundle_version || "—"}</span></p>
          </ROSection>
        )}

        {isVms && !isBundle && (report.images ?? []).some((i) => i.image_name) && (
          <ROSection title="VMS 이미지 버전">
            <div className="overflow-x-auto rounded-lg border border-line/70">
              <table className="w-full text-[11px]">
                <thead><tr className="bg-input/60 text-faint"><th className="px-2 py-1.5 text-left font-medium">이미지</th><th className="px-2 py-1.5 text-left font-medium">버전</th></tr></thead>
                <tbody className="divide-y divide-line/60">
                  {(report.images ?? []).filter((i) => i.image_name).map((im, i) => (
                    <tr key={i}><td className="px-2 py-1 text-ink2">{im.image_name}</td><td className="px-2 py-1 font-mono text-faint">{im.version || "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ROSection>
        )}

        {/* 레거시(구버전) 자유서술 리포트 호환 */}
        {report.contents && <ROBlock label="점검 내용(구버전)" value={report.contents} />}
        {report.results && <ROBlock label="점검 결과(구버전)" value={report.results} />}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={() => { exportInspectionXlsx({ ...inspection, report }).catch((e) => { console.error(e); alert("엑셀 내보내기 실패: " + (e instanceof Error ? e.message : String(e))); }); }} className="px-4 py-2 rounded-lg text-sm text-cyan-300 border border-cyan-800/60 hover:bg-cyan-900/20 transition-colors">엑셀 내보내기</button>
          <button onClick={() => setEditing(true)} className="px-4 py-2 rounded-lg text-sm bg-cyan-700 hover:bg-cyan-600 text-white font-medium transition-colors">수정</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {err && <p className="text-xs text-red-400">{err}</p>}

      {/* 1. 개요 */}
      <Section title="1. 개요">
        <div className="grid grid-cols-2 gap-2">
          <Field label="점검일"><input type="date" value={completedDate} onChange={(e) => { setCompletedDate(e.target.value); setNextSched(""); }} className={inputCls} /></Field>
          <Field label="점검자"><input value={inspector} onChange={(e) => setInspector(e.target.value)} className={inputCls} placeholder="점검자" /></Field>
        </div>
        <Field label="목적"><input value={purpose} onChange={(e) => setPurpose(e.target.value)} className={inputCls} placeholder="점검 목적" /></Field>
      </Section>

      {/* 2-1 운영 환경 */}
      <Section title="2-1. 운영 환경">
        <div className="grid grid-cols-2 gap-2">
          <Field label="검사 방식">
            <div className="flex rounded-lg border border-line2 overflow-hidden w-fit">
              {INSPECT_TYPES.map((t) => {
                const active = (report.env.inspect_type ?? "remote") === t.key;
                return (
                  <button key={t.key} type="button" onClick={() => changeInspectType(t.key)}
                    className={`px-4 py-2 text-sm transition-colors ${active ? "bg-cyan-700 text-white" : "text-muted hover:text-ink hover:bg-input"}`}>
                    {t.label}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="제품명">
            <select value={report.env.product_name} onChange={(e) => changeProduct(e.target.value)} className={inputCls}>
              <option value="">선택</option>
              {PRODUCT_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="최초 설치 일"><input type="date" value={report.env.install_date} onChange={(e) => setEnv("install_date", e.target.value)} className={inputCls} /></Field>
          <Field label="점검 일"><input type="date" value={report.env.inspect_date} onChange={(e) => { setEnv("inspect_date", e.target.value); setNextSched(""); }} className={inputCls} /></Field>
          <Field label="제품버전"><input value={report.env.product_version} onChange={(e) => setEnv("product_version", e.target.value)} className={inputCls} /></Field>
        </div>
      </Section>

      {/* VMS 이미지 버전 (제품명 VMS일 때) */}
      {isVms && (
        <Section title={`VMS ${isBundle ? "번들 버전" : "이미지 버전"} (IMS 서비스 납품정보)`}>
          <p className="text-[11px] text-faint">배포 방식: <span className="text-ink2">{deployMode || "미확인"}</span></p>

          {isBundle ? (
            // ── 배포방식 BUNDLE: 번들 버전 + 구성 상세 ──
            (() => {
              const sel = bundles.find((b) => b.name === (report.bundle_version ?? ""));
              return (
                <div className="space-y-2">
                  <Field label="번들 버전">
                    <input
                      value={report.bundle_version ?? ""}
                      onChange={(e) => setReport((r) => ({ ...r, bundle_version: e.target.value }))}
                      list={`bundlever-${inspection.id}`}
                      className={inputCls}
                      placeholder="번들 버전 선택 또는 입력 (예: R-26.06.1)"
                    />
                    <datalist id={`bundlever-${inspection.id}`}>
                      {bundles.map((b) => <option key={b.name} value={b.name} />)}
                    </datalist>
                  </Field>
                  <details className="rounded-lg border border-line/70 bg-input/20" open>
                    <summary className="cursor-pointer select-none px-3 py-2 text-[11px] text-muted hover:text-ink">
                      번들 구성 상세{sel ? ` — ${sel.name}` : ""} (펼치기)
                    </summary>
                    {sel ? (
                      <div className="px-3 pb-3 pt-1 space-y-2">
                        {sel.appliedSites.length > 0 && (
                          <p className="text-[11px] text-faint">적용 사이트: <span className="text-ink2">{sel.appliedSites.join(", ")}</span></p>
                        )}
                        <div className="overflow-x-auto rounded-lg border border-line/60">
                          <table className="w-full text-[11px]">
                            <thead><tr className="bg-input/60 text-faint"><th className="px-2 py-1.5 text-left font-medium">컴포넌트</th><th className="px-2 py-1.5 text-left font-medium">버전</th></tr></thead>
                            <tbody className="divide-y divide-line/60">
                              {Object.entries(sel.components).map(([k, v]) => (
                                <tr key={k}><td className="px-2 py-1 text-ink2">{k}</td><td className="px-2 py-1 font-mono text-faint">{v}</td></tr>
                              ))}
                              {Object.keys(sel.components).length === 0 && (
                                <tr><td colSpan={2} className="px-2 py-2 text-center text-faint">구성 정보 없음</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : (
                      <p className="px-3 pb-3 pt-1 text-[11px] text-faint">
                        {bundles.length === 0 ? "번들 목록을 불러오지 못했습니다(릴리즈노트 접근 확인)." : "선택한 번들 버전이 릴리즈노트 목록에 없습니다."}
                      </p>
                    )}
                  </details>
                </div>
              );
            })()
          ) : (
            // ── 배포방식 MANUAL: 이미지별 버전 ──
            <div className="overflow-x-auto rounded-lg border border-line/70">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-input/60 text-faint">
                    <th className="px-2 py-1.5 text-left font-medium w-2/5">이미지</th>
                    <th className="px-2 py-1.5 text-left font-medium">버전</th>
                    <th className="px-2 py-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/60">
                  {images.length === 0 && (
                    <tr><td colSpan={3} className="px-2 py-3 text-center text-faint">이미지가 없습니다. [IMS 다시 불러오기]로 채우세요.</td></tr>
                  )}
                  {images.map((im, i) => (
                    <tr key={i}>
                      <td className="px-1.5 py-1"><input value={im.image_name} onChange={(e) => setImage(i, "image_name", e.target.value)} className="w-full bg-input border border-line2 rounded px-2 py-1 text-[11px] text-ink focus:outline-none focus:border-cyan-600" placeholder="이미지명" /></td>
                      <td className="px-1.5 py-1">
                        <input
                          value={im.version}
                          onChange={(e) => setImage(i, "version", e.target.value)}
                          list={`imgver-${inspection.id}-${i}`}
                          className="w-full bg-input border border-line2 rounded px-2 py-1 text-[11px] font-mono text-ink focus:outline-none focus:border-cyan-600"
                          placeholder="버전 선택 또는 입력"
                        />
                        <datalist id={`imgver-${inspection.id}-${i}`}>
                          {(imgOpts[im.image_name] ?? imgOpts[im.image_name?.toLowerCase()] ?? []).map((v) => <option key={v} value={v} />)}
                        </datalist>
                      </td>
                      <td className="px-1.5 py-1 text-right"><button type="button" onClick={() => removeImage(i)} className="text-faint hover:text-red-400">✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!isBundle && <button type="button" onClick={addImage} className="text-xs text-cyan-400 hover:text-cyan-300">+ 이미지 행</button>}
            <button type="button" onClick={() => loadImsImages(true)} className="text-xs text-muted hover:text-ink">IMS 다시 불러오기</button>
            <span className="flex-1" />
            <button type="button" onClick={syncIms} disabled={imsBusy || !shipment?.shipment_id} title={shipment?.shipment_id ? "이 점검 기준으로 IMS 납품정보에 반영" : "연결된 납품이 없습니다"} className="px-3 py-1.5 text-xs rounded-lg bg-purple-800/60 text-purple-200 border border-purple-700/60 hover:bg-purple-800 disabled:opacity-40 transition-colors">
              {imsBusy ? "반영 중…" : "IMS 납품정보에 반영"}
            </button>
          </div>
          {imsMsg && <p className={`text-[11px] ${imsMsg.ok ? "text-green-400" : "text-red-400"}`}>{imsMsg.text}</p>}
        </Section>
      )}

      {/* 2-2 점검 내용 (체크리스트) */}
      <Section title="2-2. 점검 내용">
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-faint">{INSPECT_TYPES.find((t) => t.key === (report.env.inspect_type ?? "remote"))?.label} 기준 · 검사결과(N/A·Pass·Fail)를 선택하세요</p>
          <button type="button" onClick={() => loadDefaultChecklist(report.env.inspect_type ?? "remote")} className="text-xs text-muted hover:text-ink">기본 항목 불러오기</button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-line/70">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-input/60 text-faint">
                <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">유형</th>
                <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">점검항목</th>
                <th className="px-2 py-1.5 text-left font-medium">검사방법</th>
                <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">검사결과</th>
                <th className="px-2 py-1.5 text-left font-medium">조치결과</th>
                <th className="px-2 py-1.5 text-left font-medium">비고</th>
                <th className="px-2 py-1.5 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {(report.checklist ?? []).length === 0 && (
                <tr><td colSpan={7} className="px-2 py-3 text-center text-faint">항목이 없습니다. [기본 항목 불러오기] 또는 [+ 항목 추가].</td></tr>
              )}
              {(report.checklist ?? []).map((c, i) => (
                <tr key={i} className="align-top">
                  <td className="px-1.5 py-1"><input value={c.type} onChange={(e) => setCheck(i, "type", e.target.value)} className="w-16 bg-input border border-line2 rounded px-1.5 py-1 text-[11px] text-ink focus:outline-none focus:border-cyan-600" /></td>
                  <td className="px-1.5 py-1"><input value={c.item} onChange={(e) => setCheck(i, "item", e.target.value)} className="w-32 bg-input border border-line2 rounded px-1.5 py-1 text-[11px] text-ink focus:outline-none focus:border-cyan-600" /></td>
                  <td className="px-1.5 py-1"><textarea value={c.method} onChange={(e) => setCheck(i, "method", e.target.value)} rows={2} className="w-full min-w-[10rem] bg-input border border-line2 rounded px-1.5 py-1 text-[11px] text-faint focus:outline-none focus:border-cyan-600 resize-y" /></td>
                  <td className="px-1.5 py-1">
                    <select value={c.result} onChange={(e) => setCheck(i, "result", e.target.value)} className={`w-20 bg-input border rounded px-1.5 py-1 text-[11px] focus:outline-none focus:border-cyan-600 ${c.result === "Pass" ? "text-green-300 border-green-700/50" : c.result === "Fail" ? "text-red-300 border-red-700/50" : "text-faint border-line2"}`}>
                      <option value="">—</option>
                      {CHECK_RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="px-1.5 py-1"><textarea value={c.action} onChange={(e) => setCheck(i, "action", e.target.value)} rows={2} className="w-full min-w-[8rem] bg-input border border-line2 rounded px-1.5 py-1 text-[11px] text-ink focus:outline-none focus:border-cyan-600 resize-y" /></td>
                  <td className="px-1.5 py-1"><textarea value={c.note} onChange={(e) => setCheck(i, "note", e.target.value)} rows={2} className="w-full min-w-[6rem] bg-input border border-line2 rounded px-1.5 py-1 text-[11px] text-ink focus:outline-none focus:border-cyan-600 resize-y" /></td>
                  <td className="px-1.5 py-1 text-right"><button type="button" onClick={() => removeCheck(i)} className="text-faint hover:text-red-400">✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" onClick={addCheck} className="text-xs text-cyan-400 hover:text-cyan-300">+ 항목 추가</button>
      </Section>

      {/* 2-3 탐지현황 통계 (이벤트 × TP/FP × 날짜) */}
      <Section title="2-3. 탐지현황 통계">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-faint">기간 단위</span>
          <div className="flex rounded-lg border border-line overflow-hidden">
            {DETECTION_UNITS.map((u) => (
              <button
                key={u.key}
                type="button"
                onClick={() => setDetUnit(u.key)}
                className={`px-2.5 py-1 text-[11px] transition-colors ${det.unit === u.key ? "bg-cyan-700 text-white" : "text-muted hover:text-ink hover:bg-input"}`}
              >
                {u.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-faint">날짜 열은 달력에서 선택</span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-line/70">
          <table className="w-full text-[11px] text-center">
            <thead>
              <tr className="bg-input/60 text-faint">
                <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">이벤트명</th>
                <th className="px-2 py-1.5 font-medium whitespace-nowrap">탐지결과</th>
                {det.dates.map((d, ci) => (
                  <th key={ci} className="px-1 py-1.5 font-medium">
                    <div className="flex items-center gap-0.5">
                      <input
                        type={det.unit === "week" ? "week" : det.unit === "month" ? "month" : "date"}
                        value={d}
                        onChange={(e) => setDetDate(ci, e.target.value)}
                        className="bg-input border border-line2 rounded px-1 py-0.5 text-[11px] text-center text-faint focus:outline-none focus:border-cyan-600"
                      />
                      <button type="button" onClick={() => removeDetDate(ci)} className="text-faint hover:text-red-400 text-[10px]" title="날짜 삭제">✕</button>
                    </div>
                  </th>
                ))}
                <th className="px-2 py-1.5 font-medium">Total</th>
                <th className="px-1.5 py-1.5 w-6"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {det.events.map((e, ei) => (
                <Fragment key={ei}>
                  <tr>
                    <td rowSpan={2} className="px-2 py-1 text-left align-top">
                      <input value={e.name} onChange={(ev) => setDetName(ei, ev.target.value)} className="w-20 bg-input border border-line2 rounded px-1.5 py-1 text-[11px] text-ink focus:outline-none focus:border-cyan-600" placeholder="이벤트명" />
                    </td>
                    <td className="px-2 py-1 text-green-300 font-medium">TP</td>
                    {e.tp.map((v, ci) => (
                      <td key={ci} className="px-0.5 py-0.5"><input value={v ?? ""} onChange={(ev) => setDetCell(ei, "tp", ci, ev.target.value)} inputMode="numeric" className="w-11 bg-input border border-line2 rounded px-1 py-1 text-[11px] text-center text-ink focus:outline-none focus:border-cyan-600" placeholder="-" /></td>
                    ))}
                    <td className="px-2 py-1 font-mono text-faint">{dash(sumArr(e.tp))}</td>
                    <td rowSpan={2} className="px-1.5 py-1 align-middle"><button type="button" onClick={() => removeDetEvent(ei)} className="text-faint hover:text-red-400" title="이벤트 삭제">✕</button></td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1 text-red-300 font-medium">FP</td>
                    {e.fp.map((v, ci) => (
                      <td key={ci} className="px-0.5 py-0.5"><input value={v ?? ""} onChange={(ev) => setDetCell(ei, "fp", ci, ev.target.value)} inputMode="numeric" className="w-11 bg-input border border-line2 rounded px-1 py-1 text-[11px] text-center text-ink focus:outline-none focus:border-cyan-600" placeholder="-" /></td>
                    ))}
                    <td className="px-2 py-1 font-mono text-faint">{dash(sumArr(e.fp))}</td>
                  </tr>
                </Fragment>
              ))}
              {/* Total 행 */}
              <tr className="bg-input/50 font-medium">
                <td className="px-2 py-1.5 text-left">Total</td>
                <td className="px-2 py-1.5 text-faint">-</td>
                {det.dates.map((_d, ci) => <td key={ci} className="px-1 py-1.5 font-mono">{dash(detColTotal(ci))}</td>)}
                <td className="px-2 py-1.5 font-mono text-cyan-300">{dash(detGrandTotal)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={addDetEvent} className="text-xs text-cyan-400 hover:text-cyan-300">+ 이벤트</button>
          <button type="button" onClick={addDetDate} className="text-xs text-muted hover:text-ink">+ 날짜(열)</button>
        </div>
        <details className="rounded-lg border border-line/70 bg-input/20">
          <summary className="cursor-pointer select-none px-3 py-2 text-[11px] text-muted hover:text-ink">방문검사 이벤트 통계 쿼리 예시 (펼치기)</summary>
          <pre className="px-3 pb-3 pt-1 text-[10.5px] text-faint font-mono whitespace-pre-wrap overflow-x-auto">{EVENT_STATS_QUERY_EXAMPLE}</pre>
        </details>
      </Section>

      {/* 2-4 고객민원 및 특이사항 */}
      <Section title="2-4. 고객민원 및 특이사항">
        <textarea value={report.complaints ?? ""} onChange={(e) => setReport((r) => ({ ...r, complaints: e.target.value }))} className={ta} placeholder="시스템 사용에 대한 애로·문의 사항, 기타 특이사항을 기록하세요." />
      </Section>

      {/* 3. 후속 점검 계획 — 다음 일정 자동 등록 */}
      <Section title="3. 후속 점검 계획 (다음 일정 자동 등록)">
        <label className="flex items-center gap-2 text-xs text-ink2">
          <input type="checkbox" checked={scheduleNext} onChange={(e) => setScheduleNext(e.target.checked)} className="accent-cyan-500" />
          완료 시 다음 점검 일정을 달력에 자동 등록
        </label>
        {scheduleNext && (
          <div className="grid grid-cols-3 gap-2 mt-1">
            <Field label="다음 점검명">
              <select value={nextName} onChange={(e) => { setNextName(e.target.value as typeof nextName); setNextCycle((DEFAULT_CYCLE[e.target.value] ?? "1개월") as Cycle); }} className={inputCls}>
                {INSPECTION_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              {nextName === CUSTOM_INSPECTION_NAME && (
                <input value={nextCustomName} onChange={(e) => setNextCustomName(e.target.value)}
                  className={`${inputCls} mt-1`} placeholder="점검명 직접 입력" autoFocus />
              )}
            </Field>
            <Field label="점검주기">
              <select value={nextCycle} onChange={(e) => { setNextCycle(e.target.value as Cycle); setNextSched(""); }} className={inputCls}>
                {CYCLES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="다음 예정일">
              <input type="date" value={computedNext} onChange={(e) => setNextSched(e.target.value)} className={inputCls} />
              {nextCycle === "없음" && (
                <p className="mt-1 text-[11px] text-muted">주기 &lsquo;없음&rsquo; — 예정일을 직접 입력하세요.</p>
              )}
            </Field>
          </div>
        )}
      </Section>

      <div className="flex gap-3 pt-1">
        {isCompleted ? (
          <>
            <button onClick={() => setEditing(false)} disabled={saving} className="flex-1 px-4 py-2 rounded-lg text-sm text-muted hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-50">취소</button>
            <button onClick={() => submit(false)} disabled={saving} className="flex-1 px-4 py-2 rounded-lg text-sm bg-cyan-700 hover:bg-cyan-600 text-white font-medium transition-colors disabled:opacity-50">{saving ? "저장 중…" : "저장"}</button>
          </>
        ) : (
          <>
            <button onClick={onCancel} disabled={saving} className="flex-1 px-4 py-2 rounded-lg text-sm text-muted hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-50">취소</button>
            <button onClick={() => submit(false)} disabled={saving} className="px-4 py-2 rounded-lg text-sm text-cyan-300 border border-cyan-800/60 hover:bg-cyan-900/20 transition-colors disabled:opacity-50">임시 저장</button>
            <button onClick={() => submit(true)} disabled={saving} className="flex-1 px-4 py-2 rounded-lg text-sm bg-cyan-700 hover:bg-cyan-600 text-white font-medium transition-colors disabled:opacity-50">{saving ? "처리 중…" : "완료 처리"}</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── 공용 소형 컴포넌트 ─────────────────────────────────────────────────────────

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`bg-panel border border-line2 rounded-xl w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[90vh] overflow-y-auto shadow-2xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-line sticky top-0 bg-panel z-10">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="text-faint hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>
        <div className="px-6 py-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

function ModalActions({ onClose, onSubmit, saving, label }: { onClose: () => void; onSubmit: () => void; saving: boolean; label: string }) {
  return (
    <div className="flex gap-3 pt-1">
      <button onClick={onClose} disabled={saving} className="flex-1 px-4 py-2 rounded-lg text-sm text-muted hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-50">취소</button>
      <button onClick={onSubmit} disabled={saving} className="flex-1 px-4 py-2 rounded-lg text-sm bg-cyan-700 hover:bg-cyan-600 text-white font-medium transition-colors disabled:opacity-50">{saving ? "저장 중…" : label}</button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">{title}</p>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}

/** 읽기 전용 섹션 래퍼 */
function ROSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">{title}</p>
      {children}
    </div>
  );
}

/** 체크리스트 읽기 전용 표 */
function ChecklistTable({ rows, readOnly }: { rows: CheckItem[]; readOnly?: boolean }) {
  void readOnly;
  const resultCls = (r: string) => r === "Pass" ? "text-green-300" : r === "Fail" ? "text-red-300" : "text-faint";
  return (
    <div className="overflow-x-auto rounded-lg border border-line/70">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-input/60 text-faint">
            {["유형", "점검항목", "검사방법", "검사결과", "조치결과", "비고"].map((h) => (
              <th key={h} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {rows.map((c, i) => (
            <tr key={i} className="align-top">
              <td className="px-2 py-1 text-ink2 whitespace-nowrap">{c.type || "—"}</td>
              <td className="px-2 py-1 text-ink2 whitespace-nowrap">{c.item || "—"}</td>
              <td className="px-2 py-1 text-faint whitespace-pre-wrap min-w-[10rem]">{c.method || "—"}</td>
              <td className={`px-2 py-1 whitespace-nowrap font-medium ${resultCls(c.result)}`}>{c.result || "—"}</td>
              <td className="px-2 py-1 text-ink2 whitespace-pre-wrap">{c.action || "—"}</td>
              <td className="px-2 py-1 text-ink2 whitespace-pre-wrap">{c.note || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 탐지현황 통계 읽기 전용 매트릭스 (이벤트 × TP/FP × 날짜) */
function DetectionStatsView({ det }: { det: DetectionStats }) {
  const sum = (a: (number | null)[]) => a.reduce((s: number, n) => s + (n ?? 0), 0);
  const colTotal = (ci: number) => det.events.reduce((s, e) => s + (e.tp[ci] ?? 0) + (e.fp[ci] ?? 0), 0);
  const grand = det.dates.reduce((s, _d, ci) => s + colTotal(ci), 0);
  const dash = (n: number) => (n ? String(n) : "-");
  const cell = (v: number | null) => (v != null ? String(v) : "-");
  return (
    <div className="overflow-x-auto rounded-lg border border-line/70">
      <table className="w-full text-[11px] text-center">
        <thead>
          <tr className="bg-input/60 text-faint">
            <th className="px-2 py-1.5 text-left font-medium">이벤트명</th>
            <th className="px-2 py-1.5 font-medium">탐지결과</th>
            {det.dates.map((d, i) => <th key={i} className="px-2 py-1.5 font-medium">{formatDetectionDate(d, det.unit)}</th>)}
            <th className="px-2 py-1.5 font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {det.events.map((e, ei) => (
            <Fragment key={ei}>
              <tr>
                <td rowSpan={2} className="px-2 py-1 text-left align-top text-ink2">{e.name || "-"}</td>
                <td className="px-2 py-1 text-green-300">TP</td>
                {e.tp.map((v, i) => <td key={i} className="px-2 py-1 font-mono text-ink2">{cell(v)}</td>)}
                <td className="px-2 py-1 font-mono text-faint">{dash(sum(e.tp))}</td>
              </tr>
              <tr>
                <td className="px-2 py-1 text-red-300">FP</td>
                {e.fp.map((v, i) => <td key={i} className="px-2 py-1 font-mono text-ink2">{cell(v)}</td>)}
                <td className="px-2 py-1 font-mono text-faint">{dash(sum(e.fp))}</td>
              </tr>
            </Fragment>
          ))}
          <tr className="bg-input/50 font-medium">
            <td className="px-2 py-1.5 text-left">Total</td>
            <td className="px-2 py-1.5 text-faint">-</td>
            {det.dates.map((_d, ci) => <td key={ci} className="px-2 py-1.5 font-mono">{dash(colTotal(ci))}</td>)}
            <td className="px-2 py-1.5 font-mono text-cyan-300">{dash(grand)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** 읽기 전용 항목 (라벨/값) */
function RO({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[11px] text-faint">{label}</span>
      <span className="text-ink2">{value}</span>
    </div>
  );
}

/** 읽기 전용 본문 블록 (여러 줄) */
function ROBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted mb-1">{label}</p>
      <p className="text-ink2 whitespace-pre-wrap leading-relaxed bg-input/30 rounded-lg px-3 py-2 border border-line/60">{value}</p>
    </div>
  );
}
