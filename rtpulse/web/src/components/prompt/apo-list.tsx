"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import type { ApoDbTab, VmsConn } from "./apo-config";

// ─── Types ────────────────────────────────────────────────────────────────────

type DetResult = "TP" | "FP" | "TN" | "FN" | null;

/** copy_camera_events 컬럼명 기준 (Excel 명세서 통일) */
interface ApoEvent {
  _id:               string;
  customer_id:       string;
  customer_name:     string | null;
  camera_id:         string | null;
  event_name:        string | null;
  event_time:        string | null;
  updated_at:        string;
  result:            DetResult;
  label_name:        string | null;
  new_event_name:    string | null;
  auto_labeling:     boolean;
  auto_label_reason: string | null;
  is_watched:        boolean;
  is_deleted:        boolean;
  thumbnail:         string | null;
  video_url:         string | null;
  is_media_exist:    boolean;
  roi_coordinates:   string | null;
  type:              string | null;
}

interface ApoStats {
  tp: number; fp: number; tn: number; fn: number;
  unlabeled: number; autoLabeledCount: number; watchedCount: number;
}

interface ApoResponse {
  events:     ApoEvent[];
  total:      number;
  page:       number;
  pageSize:   number;
  totalPages: number;
  stats:      ApoStats;
  meta:       { eventNames: string[]; cameraIds: string[] };
}

interface Customer { id: string; name: string; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LABEL_NAMES = ["normal", "falldown", "fire", "smoke", "esfalldown"] as const;
type LabelName = typeof LABEL_NAMES[number];

const LABEL_COLOR: Record<LabelName, string> = {
  fire:        "bg-red-900/40 text-red-300 border-red-700/50",
  falldown:    "bg-orange-900/40 text-orange-300 border-orange-700/50",
  esfalldown:  "bg-purple-900/40 text-purple-300 border-purple-700/50",
  smoke:       "bg-slate-700/60 text-slate-300 border-slate-500/50",
  normal:      "bg-gray-700/60 text-gray-300 border-gray-500/50",
};

const RESULT_COLOR: Record<string, string> = {
  TP: "bg-green-900/40 text-green-300 border-green-700/50",
  FP: "bg-red-900/40 text-red-300 border-red-700/50",
  TN: "bg-blue-900/40 text-blue-300 border-blue-700/50",
  FN: "bg-amber-900/40 text-amber-300 border-amber-700/50",
};

function ResultChip({ result }: { result: DetResult }) {
  if (!result) return <span className="text-faint text-xs">미선택</span>;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold border ${RESULT_COLOR[result]}`}>
      {result}
    </span>
  );
}

function LabelChip({ name }: { name: string | null }) {
  if (!name) return <span className="text-faint text-xs">—</span>;
  const cls = LABEL_COLOR[name as LabelName] ?? "bg-gray-700/60 text-gray-300 border-gray-500/50";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] border ${cls}`}>
      {name}
    </span>
  );
}

function fmt(dt: string | null): string {
  if (!dt) return "—";
  return dt.slice(0, 16).replace("T", " ");
}

const selectCls = "bg-input border border-line2 rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-purple-600 min-w-[120px]";

// ─── Detail Modal ─────────────────────────────────────────────────────────────

interface DetailModalProps {
  event:     ApoEvent;
  connTab:   ApoDbTab;
  vmsConn?: VmsConn;
  onClose:   () => void;
  onSaved:   (updated: Partial<ApoEvent>) => void;
  onPrev?:   () => void;
  onNext?:   () => void;
  hasPrev?:  boolean;
  hasNext?:  boolean;
}

const KBD = ({ k }: { k: string }) => (
  <kbd className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono font-bold bg-gray-700/80 text-gray-400 border border-gray-600 leading-none ml-1">
    {k}
  </kbd>
);

function DetailModal({ event, connTab, vmsConn, onClose, onSaved, onPrev, onNext, hasPrev, hasNext }: DetailModalProps) {
  const [localResult, setLocalResult] = useState<DetResult>(event.result);
  const [localLabel,  setLocalLabel]  = useState<string | null>(event.label_name);
  const [saving,      setSaving]      = useState(false);
  const [imgError,    setImgError]    = useState(false);
  // 버튼을 하나라도 눌렀는지 추적 → 방향키 이동 시 자동 저장+검수완료 여부 결정
  const [touched,     setTouched]     = useState(false);

  const pickResult = (r: DetResult)      => { setLocalResult(r); setTouched(true); };
  const pickLabel  = (ln: string | null) => { setLocalLabel(ln);  setTouched(true); };

  const thumbSrc = event.thumbnail
    ? /^https?:\/\//.test(event.thumbnail)
      ? event.thumbnail  // VMS DB — 완성된 HTTP URL 그대로 사용
      : event.thumbnail.includes("/minio/")
        ? `/api/minio/${event.customer_id}/thumbnail?path=${encodeURIComponent(event.thumbnail)}`
        : `/api/nas/${event.customer_id}/file?path=${encodeURIComponent(event.thumbnail)}&type=thumbnail`
    : null;

  // onDone: 저장 후 실행할 콜백 (미전달 시 onClose — 기존 동작 유지)
  const save = useCallback(async (markWatched = false, onDone?: () => void) => {
    setSaving(true);
    try {
      if (connTab === "vms" && vmsConn) {
        // VMS 모드: VMS MySQL DB 직접 업데이트
        await fetch(`/api/apo/vms/events/${encodeURIComponent(event._id)}/label`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conn:       vmsConn,
            result:     localResult,
            label_name: localLabel,
            isWatched:  markWatched,
          }),
        });
      } else {
        // Watch 모드: RTPulse PostgreSQL 업데이트
        await fetch("/api/apo/events", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId: event.customer_id,
            id:         event._id,
            result:     localResult,
            labelName:  localLabel,
            ...(markWatched ? { isWatched: true } : {}),
          }),
        });
      }

      onSaved({
        result:        localResult,
        label_name:    localLabel,
        auto_labeling: false,
        ...(markWatched ? { is_watched: true } : {}),
      });
      if (markWatched) (onDone ?? onClose)();
    } catch (e) {
      alert("저장 실패: " + String(e));
    } finally {
      setSaving(false);
    }
  }, [event.customer_id, event._id, localResult, localLabel, connTab, onSaved, onClose]);

  // ── 방향키 네비게이션 (touched 상태에 따라 자동 저장+검수완료) ───────────
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);

  const navigatePrev = useCallback(() => {
    if (touched) saveRef.current(true, () => onPrev?.());
    else onPrev?.();
  }, [touched, onPrev]);

  const navigateNext = useCallback(() => {
    if (touched) saveRef.current(true, () => onNext?.());
    else onNext?.();
  }, [touched, onNext]);

  const navigatePrevRef = useRef(navigatePrev);
  const navigateNextRef = useRef(navigateNext);
  useEffect(() => { navigatePrevRef.current = navigatePrev; }, [navigatePrev]);
  useEffect(() => { navigateNextRef.current = navigateNext; }, [navigateNext]);

  // ── 키보드 단축키 ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "1": e.preventDefault(); pickResult("TP");  break;
        case "2": e.preventDefault(); pickResult("FP");  break;
        case "3": e.preventDefault(); pickResult("TN");  break;
        case "4": e.preventDefault(); pickResult("FN");  break;
        case "5": e.preventDefault(); pickResult(null);  break; // PASS
        case "q": case "Q": e.preventDefault(); pickLabel("normal");     break;
        case "w": case "W": e.preventDefault(); pickLabel("falldown");   break;
        case "e": case "E": e.preventDefault(); pickLabel("fire");       break;
        case "r": case "R": e.preventDefault(); pickLabel("smoke");      break;
        case "t": case "T": e.preventDefault(); pickLabel("esfalldown"); break;
        case "Enter":      e.preventDefault(); saveRef.current(true);       break;
        case "s": case "S": e.preventDefault(); saveRef.current(false);     break;
        case "Escape":     e.preventDefault(); onClose();                   break;
        case "ArrowLeft":  e.preventDefault(); navigatePrevRef.current();   break;
        case "ArrowRight": e.preventDefault(); navigateNextRef.current();   break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-panel border border-line2 rounded-2xl w-full max-w-2xl mx-4 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line sticky top-0 bg-panel z-10">
          <div>
            <h2 className="text-sm font-semibold text-ink">이벤트 라벨링</h2>
            <p className="text-xs text-faint mt-0.5 font-mono">{event._id}</p>
          </div>
          <div className="flex items-center gap-2">
            {/* 이전 / 다음 네비게이션 */}
            <button
              onClick={navigatePrev}
              disabled={!hasPrev}
              title="이전 이벤트 (←)"
              className="p-1.5 rounded-lg text-faint hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={navigateNext}
              disabled={!hasNext}
              title="다음 이벤트 (→)"
              className="p-1.5 rounded-lg text-faint hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button onClick={onClose} className="text-faint hover:text-gray-300 text-xl leading-none ml-1">&times;</button>
          </div>
        </div>

        {/* 단축키 힌트 바 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2 bg-input/30 border-b border-line text-[10px] text-faint">
          <span>탐지: <KBD k="1"/>TP <KBD k="2"/>FP <KBD k="3"/>TN <KBD k="4"/>FN <KBD k="5"/>PASS</span>
          <span>라벨: <KBD k="Q"/>normal <KBD k="W"/>falldown <KBD k="E"/>fire <KBD k="R"/>smoke <KBD k="T"/>esfalldown</span>
          <span><KBD k="Enter"/>저장+완료 <KBD k="S"/>저장 <KBD k="Esc"/>취소 <KBD k="←"/>이전 <KBD k="→"/>다음</span>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Thumbnail */}
          <div className="flex justify-center bg-black/30 rounded-xl overflow-hidden min-h-[180px] items-center">
            {thumbSrc && !imgError ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbSrc}
                alt={event._id}
                className="max-w-full max-h-64 object-contain"
                onError={() => setImgError(true)}
              />
            ) : (
              <div className="text-center text-faint text-xs py-8 space-y-1.5 px-4">
                <svg className="w-10 h-10 mx-auto opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                {imgError ? (
                  <>
                    <p className="text-red-400">이미지 로드 실패</p>
                    <p className="font-mono text-[10px] opacity-50 break-all">{event.thumbnail}</p>
                  </>
                ) : (
                  <>
                    <p>썸네일 없음</p>
                    <p className="opacity-40 text-[10px]">copy_camera_events.thumbnail 미설정</p>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Event info */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            {[
              ["고객사",    event.customer_name || event.customer_id],
              ["카메라",    event.camera_id ? `#${event.camera_id}` : "—"],
              ["이벤트명",  event.event_name  || "—"],
              ["이벤트시각", fmt(event.event_time)],
              ["오토라벨링", event.auto_labeling ? "O" : "X"],
              ["검수",       event.is_watched   ? "✓ 완료" : "미완료"],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-faint w-20 flex-shrink-0">{k}</span>
                <span className="text-ink2 break-all">{v}</span>
              </div>
            ))}
          </div>

          {/* Auto label reason */}
          {event.auto_label_reason && (
            <div className="bg-input/40 rounded-lg px-3 py-2 text-xs text-muted leading-relaxed border border-line">
              <span className="text-faint">오토라벨링 근거: </span>{event.auto_label_reason}
            </div>
          )}

          {/* Result selector */}
          <div>
            <p className="text-xs text-faint mb-2">탐지 결과</p>
            <div className="flex gap-2 flex-wrap">
              {(["TP", "FP", "TN", "FN"] as DetResult[]).map((r, i) => (
                <button
                  key={r!}
                  onClick={() => pickResult(localResult === r ? null : r)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors flex items-center gap-1 ${
                    localResult === r
                      ? RESULT_COLOR[r!]
                      : "text-faint border-line2 hover:border-gray-500"
                  }`}
                >
                  {r}<KBD k={String(i + 1)} />
                </button>
              ))}
              <button
                onClick={() => pickResult(null)}
                className={`px-3 py-1.5 rounded-lg text-xs border transition-colors flex items-center gap-1 ${
                  localResult === null
                    ? "bg-gray-700 text-gray-300 border-gray-500"
                    : "text-faint border-line2 hover:border-gray-500"
                }`}
              >
                PASS<KBD k="5" />
              </button>
            </div>
          </div>

          {/* Label name buttons */}
          <div>
            <p className="text-xs text-faint mb-2">라벨링 결과 <span className="opacity-60">(label_name)</span></p>
            <div className="flex gap-2 flex-wrap">
              {(["normal","falldown","fire","smoke","esfalldown"] as const).map((ln, i) => (
                <button
                  key={ln}
                  onClick={() => pickLabel(localLabel === ln ? null : ln)}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-colors flex items-center gap-1 ${
                    localLabel === ln
                      ? LABEL_COLOR[ln]
                      : "text-faint border-line2 hover:border-gray-500"
                  }`}
                >
                  {ln}<KBD k={["Q","W","E","R","T"][i]} />
                </button>
              ))}
              <button
                onClick={() => pickLabel(null)}
                className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                  localLabel === null
                    ? "bg-gray-700 text-gray-300 border-gray-500"
                    : "text-faint border-line2 hover:border-gray-500"
                }`}
              >
                없음
              </button>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3 pt-1">
            <button
              onClick={onClose}
              disabled={saving}
              className="flex-1 px-4 py-2 rounded-lg text-xs text-muted hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
            >
              취소<KBD k="Esc" />
            </button>
            <button
              onClick={() => save(false)}
              disabled={saving}
              className="px-5 py-2 rounded-lg text-xs bg-purple-800 hover:bg-purple-700 text-white font-medium transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              {saving ? "저장 중..." : <><span>저장</span><KBD k="S" /></>}
            </button>
            <button
              onClick={() => save(true)}
              disabled={saving}
              className="flex-1 px-4 py-2 rounded-lg text-xs bg-cyan-700 hover:bg-cyan-600 text-white font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              {saving ? "저장 중..." : <><span>저장 + 검수 완료</span><KBD k="Enter" /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

function StatsBar({ stats, total }: { stats: ApoStats; total: number }) {
  const autoRatio    = total > 0 ? Math.round((stats.autoLabeledCount / total) * 100) : 0;
  const watchedRatio = total > 0 ? Math.round((stats.watchedCount     / total) * 100) : 0;

  const items = [
    { label: "총",       val: total,                                         cls: "text-ink" },
    { label: "TP",       val: stats.tp,                                      cls: "text-green-400" },
    { label: "FP",       val: stats.fp,                                      cls: "text-red-400" },
    { label: "TN",       val: stats.tn,                                      cls: "text-blue-400" },
    { label: "FN",       val: stats.fn,                                      cls: "text-amber-400" },
    { label: "미선택",   val: stats.unlabeled,                               cls: "text-faint" },
    { label: "오토라벨", val: `${stats.autoLabeledCount} (${autoRatio}%)`,   cls: "text-purple-400" },
    { label: "검수완료", val: `${stats.watchedCount} (${watchedRatio}%)`,    cls: "text-cyan-400" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2.5 bg-input/30 border border-line rounded-xl text-xs">
      {items.map(({ label, val, cls }) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className="text-faint">{label}</span>
          <span className={`font-semibold font-mono ${cls}`}>{val}</span>
        </span>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ApoList({
  defaultCustomerId,
  defaultStartDate,
  defaultEndDate,
  connTab,
  vmsConn,
  onNext,
}: {
  defaultCustomerId?: string;
  defaultStartDate?:  string;
  defaultEndDate?:    string;
  connTab:            ApoDbTab;
  vmsConn?:          VmsConn;
  onNext?:            () => void;
}) {
  const [customers,      setCustomers]      = useState<Customer[]>([]);
  const [response,       setResponse]       = useState<ApoResponse | null>(null);
  const [loadError,      setLoadError]       = useState<string>("");
  const [loading,        setLoading]        = useState(false);
  const [completing,     setCompleting]     = useState(false);
  const [autoLabeling,   setAutoLabeling]   = useState(false);
  const [autoLabelMsg,   setAutoLabelMsg]   = useState("");
  const [selectedEvent,  setSelectedEvent]  = useState<ApoEvent | null>(null);
  const [selectedIndex,  setSelectedIndex]  = useState<number>(-1);

  // filters
  const [customerId,   setCustomerId]   = useState(defaultCustomerId ?? "");
  const [eventName,    setEventName]    = useState("");
  const [cameraId,     setCameraId]     = useState("");
  const [resultFilter, setResultFilter] = useState("");
  const [autoLabeled,  setAutoLabeled]  = useState("");
  const [isWatched,    setIsWatched]    = useState("");
  const [startDate,    setStartDate]    = useState(defaultStartDate ?? "");
  const [endDate,      setEndDate]      = useState(defaultEndDate ?? "");
  const [page,         setPage]         = useState(1);
  const PAGE_SIZE = 50;

  useEffect(() => {
    fetch("/api/customers")
      .then((r) => r.json())
      .then((list: Customer[]) => setCustomers(list))
      .catch(console.error);
  }, []);

  const buildQuery = useCallback((pg = page) => {
    const params = new URLSearchParams();
    if (customerId)   params.set("customerId",   customerId);
    if (eventName)    params.set("eventName",     eventName);
    if (cameraId)     params.set("cameraId",      cameraId);
    if (resultFilter) params.set("result",        resultFilter);
    if (autoLabeled)  params.set("autoLabeling",  autoLabeled);
    if (isWatched)    params.set("isWatched",     isWatched);
    if (startDate)    params.set("startDate",     startDate);
    if (endDate)      params.set("endDate",       endDate);
    params.set("page",     String(pg));
    params.set("pageSize", String(PAGE_SIZE));
    return `/api/apo/events?${params.toString()}`;
  }, [customerId, eventName, cameraId, resultFilter, autoLabeled, isWatched, startDate, endDate, page]);

  const load = useCallback(async (pg = page) => {
    setLoading(true);
    setLoadError("");
    try {
      let data: ApoResponse;
      if (connTab === "vms" && vmsConn) {
        // VMS 모드: MySQL DB 직접 조회
        const res = await fetch("/api/apo/vms/events/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conn:         vmsConn,
            eventName,
            cameraId,
            result:       resultFilter,
            autoLabeling: autoLabeled,
            startDate,
            endDate,
            page:         pg,
            pageSize:     PAGE_SIZE,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `VMS DB 조회 실패 (${res.status})`);
        data = json as ApoResponse;
      } else {
        // Watch 모드: RTPulse PostgreSQL 조회
        const res = await fetch(buildQuery(pg));
        data = await res.json() as ApoResponse;
      }
      setResponse(data);
    } catch (e) {
      console.error("[apo-list] load error:", e);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connTab, vmsConn, buildQuery, eventName, cameraId, resultFilter, autoLabeled, startDate, endDate, page]);

  useEffect(() => { load(page); }, []); // initial load

  const applyFilters = () => { setPage(1); load(1); };

  // VMS 모드: 미라벨 이벤트를 Gemini로 오토라벨링 (copy_camera_events 갱신)
  const handleAutoLabel = async () => {
    if (connTab !== "vms" || !vmsConn) return;
    if (!confirm("현재 필터의 미라벨 이벤트를 Gemini로 오토라벨링합니다.\n데이터가 많으면 시간이 걸립니다 (최대 100건/회). 진행할까요?")) return;
    setAutoLabeling(true);
    setAutoLabelMsg("⏳ 오토라벨링 중... (완료까지 이 화면을 유지하세요)");
    try {
      const res = await fetch("/api/apo/vms/auto-label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conn: vmsConn, eventName, cameraId, startDate, endDate, limit: 100 }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "오토라벨링 실패");
      setAutoLabelMsg(`✓ 완료: ${j.processed}/${j.total}건 (TP ${j.tp} · FP ${j.fp} · TN ${j.tn} · FN ${j.fn}${j.errors ? ` · 오류 ${j.errors}` : ""})`);
      load(1);
    } catch (e) {
      setAutoLabelMsg(`✕ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAutoLabeling(false);
    }
  };

  const resetFilters = () => {
    setCustomerId(""); setEventName(""); setCameraId(""); setResultFilter("");
    setAutoLabeled(""); setIsWatched(""); setStartDate(""); setEndDate("");
    setPage(1);
    setTimeout(() => load(1), 0);
  };

  const handlePageChange = (pg: number) => { setPage(pg); load(pg); };

  const handleEventSaved = useCallback((updated: Partial<ApoEvent>) => {
    if (!selectedEvent || !response) return;
    const updatedEvent = { ...selectedEvent, ...updated };
    setSelectedEvent(updatedEvent);
    setResponse((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        events: prev.events.map((e) =>
          e._id === updatedEvent._id && e.customer_id === updatedEvent.customer_id
            ? updatedEvent
            : e
        ),
      };
    });
  }, [selectedEvent, response]);

  // ── 라벨링 완료 버튼 핸들러 ────────────────────────────────────────────────
  const handleLabelingComplete = async () => {
    setCompleting(true);
    try {
      const events = (response?.events ?? [])
        .filter((ev) => ev.label_name)
        .map((ev) => ({
          _id:           ev._id,
          camera_id:     ev.camera_id    ?? "",
          event_name:    ev.event_name   ?? "",
          result:        ev.result       ?? "FP",
          label_name:    ev.label_name   ?? "",
          thumbnail:     ev.thumbnail    ?? "",
          customer_id:   ev.customer_id,
          customer_name: ev.customer_name ?? undefined,
          event_time:    ev.event_time   ?? undefined,
          auto_labeling: ev.auto_labeling,
        }));

      const completionUrl = connTab === "vms"
        ? "/api/apo/vms/labelings/completion"
        : "/api/apo/watch/labelings/completion";

      const body = connTab === "vms" && vmsConn
        ? { events, conn: vmsConn, peCategory: vmsConn.peCategory }
        : { events };

      const res = await fetch(completionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok?: boolean; detail?: unknown };
      if (!res.ok || !data.ok) {
        throw new Error(`라벨링 완료 처리 실패 (${res.status})`);
      }
      onNext?.();
    } catch (e) {
      alert("라벨링 완료 처리 실패: " + String(e));
    } finally {
      setCompleting(false);
    }
  };

  const meta = useMemo(() => response?.meta ?? { eventNames: [], cameraIds: [] }, [response]);

  // ── 이전 / 다음 네비게이션 ─────────────────────────────────────────────────
  const openEvent = useCallback((idx: number) => {
    const ev = response?.events[idx];
    if (!ev) return;
    setSelectedEvent(ev);
    setSelectedIndex(idx);
  }, [response]);

  const handlePrev = useCallback(() => openEvent(selectedIndex - 1), [openEvent, selectedIndex]);
  const handleNext = useCallback(() => openEvent(selectedIndex + 1), [openEvent, selectedIndex]);

  const inputCls = "bg-input border border-line2 rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-purple-600";

  return (
    <>
      {selectedEvent && (
        <DetailModal
          key={`${selectedEvent.customer_id}-${selectedEvent._id}`}
          event={selectedEvent}
          connTab={connTab}
          vmsConn={vmsConn}
          onClose={() => { setSelectedEvent(null); setSelectedIndex(-1); load(page); }}
          onSaved={handleEventSaved}
          onPrev={selectedIndex > 0 ? handlePrev : undefined}
          onNext={response && selectedIndex < response.events.length - 1 ? handleNext : undefined}
          hasPrev={selectedIndex > 0}
          hasNext={!!response && selectedIndex < response.events.length - 1}
        />
      )}

      <div className="space-y-4">
        {/* ── 필터 바 ─────────────────────────────────────────────────────── */}
        <div className="bg-input/20 border border-line rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            {/* 고객사 */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-faint uppercase tracking-wider">고객사</label>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={selectCls}>
                <option value="">전체</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* 이벤트명 */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-faint uppercase tracking-wider">이벤트명</label>
              <select value={eventName} onChange={(e) => setEventName(e.target.value)} className={selectCls}>
                <option value="">전체</option>
                {meta.eventNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>

            {/* 카메라 */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-faint uppercase tracking-wider">카메라</label>
              <select value={cameraId} onChange={(e) => setCameraId(e.target.value)} className={selectCls}>
                <option value="">전체</option>
                {meta.cameraIds.map((c) => <option key={c} value={c}>#{c}</option>)}
              </select>
            </div>

            {/* 탐지결과 */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-faint uppercase tracking-wider">탐지결과</label>
              <select value={resultFilter} onChange={(e) => setResultFilter(e.target.value)} className={selectCls}>
                <option value="">전체</option>
                <option value="TP">TP</option>
                <option value="FP">FP</option>
                <option value="TN">TN</option>
                <option value="FN">FN</option>
                <option value="null">미선택</option>
              </select>
            </div>

            {/* 오토라벨링 */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-faint uppercase tracking-wider">오토라벨링</label>
              <select value={autoLabeled} onChange={(e) => setAutoLabeled(e.target.value)} className={selectCls}>
                <option value="">전체</option>
                <option value="true">완료</option>
                <option value="false">미완료</option>
              </select>
            </div>

            {/* 검수 */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-faint uppercase tracking-wider">검수</label>
              <select value={isWatched} onChange={(e) => setIsWatched(e.target.value)} className={selectCls}>
                <option value="">전체</option>
                <option value="true">완료</option>
                <option value="false">미완료</option>
              </select>
            </div>

            {/* 날짜 범위 */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-faint uppercase tracking-wider">시작일</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className={`${inputCls} w-36`} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-faint uppercase tracking-wider">종료일</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className={`${inputCls} w-36`} />
            </div>

            {/* 버튼 */}
            <div className="flex gap-2 items-end">
              <button
                onClick={applyFilters}
                disabled={loading}
                className="px-4 py-1.5 text-xs bg-purple-700 hover:bg-purple-600 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                {loading ? "조회 중..." : "조회"}
              </button>
              <button
                onClick={resetFilters}
                disabled={loading}
                className="px-4 py-1.5 text-xs text-muted hover:text-ink border border-line2 hover:border-gray-600 rounded-lg transition-colors disabled:opacity-50"
              >
                초기화
              </button>
              {connTab === "vms" && (
                <button
                  onClick={handleAutoLabel}
                  disabled={loading || autoLabeling}
                  title="현재 필터의 미라벨 이벤트를 Gemini로 자동 라벨링"
                  className="px-4 py-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
                >
                  {autoLabeling ? "오토라벨링 중..." : "오토라벨링"}
                </button>
              )}
            </div>
            {connTab === "vms" && autoLabelMsg && (
              <p className={`text-xs mt-2 ${autoLabelMsg.startsWith("✕") ? "text-red-400" : autoLabelMsg.startsWith("✓") ? "text-green-400" : "text-cyan-400 animate-pulse"}`}>
                {autoLabelMsg}
              </p>
            )}
          </div>
        </div>

        {/* ── 통계 바 ─────────────────────────────────────────────────────── */}
        {response && (
          <StatsBar stats={response.stats} total={response.total} />
        )}

        {/* ── 테이블 ──────────────────────────────────────────────────────── */}
        <div className="border border-line rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-input/70 text-[11px] text-muted uppercase tracking-wider">
                  {["이벤트시각", "고객사", "카메라", "이벤트명", "탐지결과", "라벨링결과", "오토", "검수", "상세"].map((h) => (
                    <th key={h} className="px-3 py-3 text-left font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {loading && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-faint text-xs">
                      <span className="animate-pulse">불러오는 중...</span>
                    </td>
                  </tr>
                )}
                {!loading && loadError && (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-red-400 text-xs whitespace-pre-line">
                      ✕ 조회 실패: {loadError}
                    </td>
                  </tr>
                )}
                {!loading && !loadError && response?.events.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-faint text-xs">
                      조회된 이벤트가 없습니다.
                    </td>
                  </tr>
                )}
                {!loading && response?.events.map((ev, i) => (
                  <tr key={`${ev.customer_id}-${ev._id}-${i}`}
                    className="hover:bg-input/30 transition-colors cursor-pointer"
                    onClick={() => { setSelectedEvent(ev); setSelectedIndex(i); }}
                  >
                    <td className="px-3 py-2.5 text-xs font-mono text-muted whitespace-nowrap">{fmt(ev.event_time)}</td>
                    <td className="px-3 py-2.5 text-xs text-ink2 whitespace-nowrap max-w-[140px] truncate">
                      {ev.customer_name || ev.customer_id}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">
                      {ev.camera_id ? `#${ev.camera_id}` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink2 whitespace-nowrap">{ev.event_name || "—"}</td>
                    <td className="px-3 py-2.5"><ResultChip result={ev.result} /></td>
                    <td className="px-3 py-2.5"><LabelChip name={ev.label_name} /></td>
                    <td className="px-3 py-2.5 text-center">
                      {ev.auto_labeling
                        ? <span className="text-purple-400 text-xs font-medium">O</span>
                        : <span className="text-faint text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {ev.is_watched
                        ? <span className="text-cyan-400 text-xs">✓</span>
                        : <span className="text-faint text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedEvent(ev); setSelectedIndex(i); }}
                        className="p-1 text-faint hover:text-purple-400 transition-colors rounded"
                        title="상세 보기"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 페이지네이션 ──────────────────────────────────────────────────── */}
        {response && response.totalPages > 1 && (
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => handlePageChange(page - 1)}
              disabled={page <= 1 || loading}
              className="px-3 py-1.5 text-xs rounded-lg border border-line2 text-muted hover:text-ink hover:border-gray-600 disabled:opacity-40 transition-colors"
            >
              ← 이전
            </button>
            <span className="text-xs text-faint">
              {page} / {response.totalPages} 페이지
              <span className="ml-2 opacity-60">(총 {response.total.toLocaleString()}건)</span>
            </span>
            <button
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= response.totalPages || loading}
              className="px-3 py-1.5 text-xs rounded-lg border border-line2 text-muted hover:text-ink hover:border-gray-600 disabled:opacity-40 transition-colors"
            >
              다음 →
            </button>
          </div>
        )}

        {/* ── Watch DB 안내 배너 ─────────────────────────────────────────── */}
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-purple-900/20 border border-purple-800/40 text-xs text-purple-300">
          <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>
            <strong>Watch DB</strong>{" "}
            (<code>copy_camera_events</code>) 데이터를 기반으로 표시됩니다.
            라벨 저장 시 APO 백엔드에도 동시에 전달됩니다.
          </span>
        </div>

        {/* ── 라벨링 완료 + 다음 버튼 ──────────────────────────────────────── */}
        {onNext && (
          <div className="flex justify-end gap-3 pt-1">
            <button
              onClick={handleLabelingComplete}
              disabled={completing || loading}
              className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-xs bg-green-700 hover:bg-green-600 text-white font-semibold transition-colors disabled:opacity-50"
            >
              {completing ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  처리 중...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  라벨링 완료
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
