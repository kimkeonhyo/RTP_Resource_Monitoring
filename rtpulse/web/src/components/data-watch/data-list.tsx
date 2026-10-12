"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Customer } from "@/lib/types";
import AutoLabelControls from "@/components/auto-label-controls";
import Image from "next/image";

interface DataRow {
  _id: number;
  camera_id: number;
  event_name: string;
  start_time: string;
  end_time: string | null;
  thumbnail: string | null;
  video_url: string | null;
  has_watched: number;
  is_media_exist: number;
  type: number;
  dis_connection: number;
}

interface Props {
  customer: Customer;
}

/** 지정 타임존의 현재 날짜 "YYYY-MM-DD" */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date());
}
/** 지정 타임존의 N일 전 날짜 "YYYY-MM-DD" */
function nDaysAgoInTz(n: number, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(
    new Date(Date.now() - n * 86_400_000),
  );
}
/**
 * UI에서 선택한 로컬(타임존) 날짜 "YYYY-MM-DD" 를 DB 조회용 UTC datetime 문자열로 변환.
 * DB는 UTC 기준으로 저장되므로, 고객사 타임존 범위를 UTC로 환산해야 한다.
 */
function localDateToUtc(dateStr: string, isEnd: boolean, tz: string): string {
  const timeStr = isEnd ? "23:59:59" : "00:00:00";
  // 타겟 날짜 정오 기준으로 offset 계산 (DST 경계 회피)
  const sampleUtc = new Date(`${dateStr}T12:00:00Z`);
  const tzMs  = new Date(sampleUtc.toLocaleString("en-US", { timeZone: tz })).getTime();
  const utcMs = new Date(sampleUtc.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const offsetMin = Math.round((tzMs - utcMs) / 60_000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const hh   = Math.floor(Math.abs(offsetMin) / 60).toString().padStart(2, "0");
  const mm   = (Math.abs(offsetMin) % 60).toString().padStart(2, "0");
  return new Date(`${dateStr}T${timeStr}${sign}${hh}:${mm}`)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

type DetectionResult = "TP" | "FP" | "TN" | "FN" | null;

// ─── SubTab helper ────────────────────────────────────────────────────────────

function SubTab({ active, onClick, label, icon }: {
  active: boolean; onClick: () => void; label: string; icon: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-3 text-xs font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-cyan-500 text-cyan-400"
          : "border-transparent text-faint hover:text-gray-300"
      }`}
    >
      <span>{icon}</span>
      {label}
    </button>
  );
}

/** label_name 값을 색상 칩으로 표시 */
function LabelNameChip({ name }: { name: string | null }) {
  if (!name) return null;
  const cls =
    name === "fire"         ? "bg-red-900/50 text-red-400 border-red-800/60"
    : name === "falldown"   ? "bg-orange-900/50 text-orange-400 border-orange-800/60"
    : name === "esfalldown" ? "bg-purple-900/50 text-purple-400 border-purple-800/60"
    : name === "smoke"      ? "bg-slate-700/50 text-slate-300 border-slate-600/60"
    :                         "bg-gray-700/50 text-gray-400 border-gray-600/60"; // normal
  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] rounded border font-mono whitespace-nowrap ${cls}`}>
      {name}
    </span>
  );
}

// ─── NasBrowse — NAS 파일 탐색 (원격 고객사용) ───────────────────────────────

const NAS_PAGE_SIZE = 50;

interface NasEntry {
  baseName: string;
  cameraId: string;
  eventName: string;
  startTime: string;
  videoFileName?: string;
  thumbFileName?: string;
  videoPath?: string;
  thumbPath?: string;
  videoSize: number;
  thumbSize: number;
  hasVideo: boolean;
  hasThumb: boolean;
}

type NasDetectionResult = "TP" | "FP" | "TN" | "FN" | null;

function NasBrowse({ customer }: { customer: Customer }) {
  const subPath = customer.name;

  const [entries,    setEntries]    = useState<NasEntry[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  const [detections,  setDetections]  = useState<Record<string, NasDetectionResult>>({});
  const [labelNames,  setLabelNames]  = useState<Record<string, string | null>>({});
  const [savingDet,   setSavingDet]   = useState<string | null>(null);

  // 썸네일 미리보기: 썸네일 보유 항목 목록 내 인덱스 (좌/우 키 이동)
  const [thumbIndex, setThumbIndex] = useState<number | null>(null);

  const [filterEvent,    setFilterEvent]    = useState("");
  const [filterCam,      setFilterCam]      = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo,   setFilterDateTo]   = useState("");
  const [filterDet,      setFilterDet]      = useState<"all" | "TP" | "FP" | "TN" | "FN" | "none">("all");

  const [page,       setPage]       = useState(0);
  const [selected,   setSelected]   = useState<Set<string>>(new Set());
  const [registered, setRegistered] = useState<Set<string>>(new Set());
  const [registering, setRegistering] = useState(false);
  const [regResult,  setRegResult]  = useState<{ ok: boolean; msg: string } | null>(null);

  const loadDetections = useCallback(async () => {
    try {
      const r = await fetch(`/api/nas/${customer.id}/detection-result`);
      if (r.ok) {
        const d = await r.json();
        setDetections(d.results    ?? {});
        setLabelNames(d.labelNames ?? {});
      }
    } catch { /**/ }
  }, [customer.id]);

  const loadRegistered = useCallback(async () => {
    try {
      const qs = subPath ? `?subPath=${encodeURIComponent(subPath)}` : "";
      const r  = await fetch(`/api/nas/${customer.id}/register-events${qs}`);
      if (r.ok) {
        const data = await r.json();
        setRegistered(new Set<string>(data.registered ?? []));
      }
    } catch { /**/ }
  }, [customer.id, subPath]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError("");
    setSelected(new Set());
    setRegResult(null);
    setPage(0);
    try {
      const qs   = subPath ? `?subPath=${encodeURIComponent(subPath)}` : "";
      const r    = await fetch(`/api/nas/${customer.id}/list${qs}`);
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? "목록 로드 실패");
      } else {
        setEntries(data.entries ?? []);
        await Promise.all([loadDetections(), loadRegistered()]);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [customer.id, subPath, loadDetections, loadRegistered]);

  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (filterCam   && !e.cameraId.toLowerCase().includes(filterCam.toLowerCase()))   return false;
      if (filterEvent && !e.eventName.toLowerCase().includes(filterEvent.toLowerCase())) return false;
      if (filterDateFrom && e.startTime && e.startTime < filterDateFrom) return false;
      if (filterDateTo   && e.startTime && e.startTime > filterDateTo + " 23:59:59") return false;
      if (filterDet !== "all") {
        const det = detections[e.baseName] ?? null;
        if (filterDet === "TP"   && det !== "TP")  return false;
        if (filterDet === "FP"   && det !== "FP")  return false;
        if (filterDet === "TN"   && det !== "TN")  return false;
        if (filterDet === "FN"   && det !== "FN")  return false;
        if (filterDet === "none" && det !== null)   return false;
      }
      return true;
    });
  }, [entries, filterCam, filterEvent, filterDateFrom, filterDateTo, filterDet, detections]);

  const totalPages   = Math.max(1, Math.ceil(filteredEntries.length / NAS_PAGE_SIZE));
  const pagedEntries = filteredEntries.slice(page * NAS_PAGE_SIZE, (page + 1) * NAS_PAGE_SIZE);

  // 썸네일 미리보기 대상(썸네일 보유 항목) — 좌/우 키로 이 목록 안에서 이동
  const thumbEntries = useMemo(
    () => filteredEntries.filter((e) => e.hasThumb && e.thumbPath),
    [filteredEntries],
  );
  const currentThumbEntry = thumbIndex !== null ? thumbEntries[thumbIndex] ?? null : null;

  useEffect(() => {
    if (thumbIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft")       setThumbIndex((i) => (i === null ? i : Math.max(0, i - 1)));
      else if (e.key === "ArrowRight") setThumbIndex((i) => (i === null ? i : Math.min(thumbEntries.length - 1, i + 1)));
      else if (e.key === "Escape")     setThumbIndex(null);
      else if (e.key === "1")          { if (currentThumbEntry) saveDetection(currentThumbEntry.baseName, "TP"); }
      else if (e.key === "2")          { if (currentThumbEntry) saveDetection(currentThumbEntry.baseName, "FP"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbIndex, thumbEntries.length, currentThumbEntry]);

  useEffect(() => { setPage(0); }, [filterCam, filterEvent, filterDateFrom, filterDateTo, filterDet]);

  const selectedThumbPaths = useMemo(() => {
    if (selected.size === 0) return undefined;
    const map: Record<string, string> = {};
    entries.forEach((e) => {
      if (selected.has(e.baseName) && e.thumbPath) map[e.baseName] = e.thumbPath;
    });
    return Object.keys(map).length > 0 ? map : undefined;
  }, [selected, entries]);

  async function saveDetection(baseName: string, result: NasDetectionResult) {
    const entry = entries.find((e) => e.baseName === baseName);
    setSavingDet(baseName);
    try {
      await fetch(`/api/nas/${customer.id}/detection-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName:  baseName,
          result,
          eventName: entry?.eventName || null,
          cameraId:  entry?.cameraId  || null,
          eventTime: entry?.startTime || null,
          thumbPath: entry?.thumbPath || null,
        }),
      });
      setDetections((prev) => ({ ...prev, [baseName]: result }));
    } finally {
      setSavingDet(null);
    }
  }

  function toggleSelect(baseName: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(baseName)) next.delete(baseName);
      else next.add(baseName);
      return next;
    });
  }

  const allSelected  = pagedEntries.length > 0 && pagedEntries.every((e) => selected.has(e.baseName));

  function toggleAll() {
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        pagedEntries.forEach((e) => next.delete(e.baseName));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        pagedEntries.forEach((e) => next.add(e.baseName));
        return next;
      });
    }
  }

  async function registerSelected() {
    if (selected.size === 0) return;
    setRegistering(true);
    setRegResult(null);
    try {
      const selectedEntries = entries.filter((e) => selected.has(e.baseName));
      const payload = selectedEntries.map((e) => ({
        baseName:  e.baseName,
        cameraId:  e.cameraId,
        eventName: e.eventName,
        startTime: e.startTime,
        subPath:   subPath,
        videoPath: e.videoPath ?? null,
        thumbPath: e.thumbPath ?? null,
        videoFile: e.videoFileName ?? null,
        thumbFile: e.thumbFileName ?? null,
      }));

      const r    = await fetch(`/api/nas/${customer.id}/register-events`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ entries: payload }),
      });
      const data = await r.json();
      if (!r.ok) {
        setRegResult({ ok: false, msg: data.error ?? "등록 실패" });
      } else {
        setRegResult({ ok: true, msg: `${data.inserted}건 등록 완료` });
        setRegistered((prev) => {
          const next = new Set(prev);
          for (const e of selectedEntries) next.add(e.baseName);
          return next;
        });
        setSelected(new Set());
      }
    } catch (e: unknown) {
      setRegResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setRegistering(false);
    }
  }

  const thumbUrl = (path: string) =>
    `/api/nas/${customer.id}/file?path=${encodeURIComponent(path)}&type=thumbnail`;
  const videoUrl = (path: string) =>
    `/api/nas/${customer.id}/file?path=${encodeURIComponent(path)}&type=video`;

  const someSelected = selected.size > 0;

  return (
    <div className="space-y-4">

      {/* 썸네일 상세보기 모달 (←/→ 로 이전·다음 이동) */}
      {currentThumbEntry && thumbIndex !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setThumbIndex(null)}
        >
          {/* 이전 */}
          <button
            onClick={(e) => { e.stopPropagation(); setThumbIndex((i) => (i === null ? i : Math.max(0, i - 1))); }}
            disabled={thumbIndex <= 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-gray-700/80 hover:bg-gray-600 text-ink text-xl flex items-center justify-center z-10 disabled:opacity-30 disabled:cursor-not-allowed"
            title="이전 (←)"
            aria-label="이전"
          >
            ‹
          </button>

          <div
            className="relative bg-panel border border-line2 rounded-xl shadow-2xl p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setThumbIndex(null)}
              className="absolute -top-3 -right-3 w-7 h-7 rounded-full bg-gray-700 hover:bg-gray-600 text-ink text-sm flex items-center justify-center z-10"
            >
              ✕
            </button>
            <div className="px-2 pt-1 pb-2 text-center">
              <p className="text-sm font-semibold text-ink truncate">
                {[currentThumbEntry.cameraId, currentThumbEntry.eventName].filter(Boolean).join(" · ")
                  || currentThumbEntry.baseName}
              </p>
            </div>
            <Image
              src={thumbUrl(currentThumbEntry.thumbPath!)}
              alt="썸네일 상세"
              width={640}
              height={480}
              className="rounded-lg bg-black object-contain"
              unoptimized
            />
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-2.5 py-1 rounded-full bg-black/70 text-white text-[11px]">
              <span>{thumbIndex + 1} / {thumbEntries.length}</span>
              <span className="opacity-40">|</span>
              {(() => {
                const cur = detections[currentThumbEntry.baseName] ?? null;
                return (
                  <>
                    <span className={cur === "TP" ? "text-green-400 font-semibold" : "text-white/70"}>[1] TP</span>
                    <span className={cur === "FP" ? "text-red-400 font-semibold" : "text-white/70"}>[2] FP</span>
                  </>
                );
              })()}
            </div>
          </div>

          {/* 다음 */}
          <button
            onClick={(e) => { e.stopPropagation(); setThumbIndex((i) => (i === null ? i : Math.min(thumbEntries.length - 1, i + 1))); }}
            disabled={thumbIndex >= thumbEntries.length - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-gray-700/80 hover:bg-gray-600 text-ink text-xl flex items-center justify-center z-10 disabled:opacity-30 disabled:cursor-not-allowed"
            title="다음 (→)"
            aria-label="다음"
          >
            ›
          </button>
        </div>
      )}

      {/* 검색 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <label className="block text-xs text-faint mb-1">NAS 서브 경로</label>
          <div className="px-3 py-1.5 bg-input/50 border border-line2 rounded-lg text-xs text-cyan-400 font-mono">
            {subPath}
          </div>
        </div>
        <button
          onClick={loadFiles}
          disabled={loading}
          className="px-3 py-1.5 text-xs bg-input text-cyan-400 border border-line2 rounded-lg hover:bg-gray-700 disabled:opacity-40 self-end"
        >
          {loading ? "조회 중..." : "조회"}
        </button>
      </div>

      {/* 필터 (데이터 로드 후) */}
      {entries.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              placeholder="카메라 ID 필터"
              value={filterCam}
              onChange={(e) => setFilterCam(e.target.value)}
              className="px-2 py-1.5 bg-panel border border-line2 rounded text-xs text-ink placeholder-gray-600 w-28 focus:outline-none focus:border-cyan-600"
            />
            <input
              type="text"
              placeholder="이벤트 이름 필터"
              value={filterEvent}
              onChange={(e) => setFilterEvent(e.target.value)}
              className="px-2 py-1.5 bg-panel border border-line2 rounded text-xs text-ink placeholder-gray-600 w-32 focus:outline-none focus:border-cyan-600"
            />
            <input
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              className="px-2 py-1.5 bg-panel border border-line2 rounded text-xs text-ink focus:outline-none focus:border-cyan-600"
            />
            <span className="text-faint text-xs">~</span>
            <input
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              className="px-2 py-1.5 bg-panel border border-line2 rounded text-xs text-ink focus:outline-none focus:border-cyan-600"
            />
            {(filterCam || filterEvent || filterDateFrom || filterDateTo) && (
              <button
                onClick={() => { setFilterCam(""); setFilterEvent(""); setFilterDateFrom(""); setFilterDateTo(""); }}
                className="px-2 py-1.5 text-xs text-faint hover:text-gray-300"
              >
                ✕ 초기화
              </button>
            )}
          </div>
          {/* 탐지결과 필터 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-faint shrink-0">탐지결과:</span>
            {(["all", "TP", "FP", "TN", "FN", "none"] as const).map((f) => {
              const active = filterDet === f;
              const cls = active
                ? f === "TP"   ? "bg-green-900/60 border-green-700 text-green-400"
                : f === "FP"   ? "bg-red-900/60 border-red-700 text-red-400"
                : f === "TN"   ? "bg-blue-900/60 border-blue-700 text-blue-400"
                : f === "FN"   ? "bg-amber-900/60 border-amber-700 text-amber-400"
                : f === "none" ? "bg-gray-700/60 border-gray-500 text-gray-300"
                :                "bg-cyan-900/60 border-cyan-700 text-cyan-400"
                : "bg-input/40 border-line2 text-faint hover:border-gray-600";
              return (
                <button
                  key={f}
                  onClick={() => setFilterDet(f)}
                  className={`px-2.5 py-0.5 text-xs rounded-full border transition-colors ${cls}`}
                >
                  {f === "all" ? "전체" : f === "none" ? "미선택" : f}
                </button>
              );
            })}
            <span className="text-[10px] text-faint ml-1">
              {(["TP", "FP", "TN", "FN", "none"] as const).map((f) => {
                const cnt = entries.filter((e) => {
                  const det = detections[e.baseName] ?? null;
                  if (f === "TP")   return det === "TP";
                  if (f === "FP")   return det === "FP";
                  if (f === "TN")   return det === "TN";
                  if (f === "FN")   return det === "FN";
                  return det === null;
                }).length;
                return cnt > 0
                  ? <span key={f} className={`mr-2 ${f === "TP" ? "text-green-700" : f === "FP" ? "text-red-700" : f === "TN" ? "text-blue-700" : f === "FN" ? "text-amber-700" : "text-faint"}`}>
                      {f === "none" ? "미선택" : f} {cnt}
                    </span>
                  : null;
              })}
            </span>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
          ✕ {error}
        </p>
      )}

      {/* 요약 + 액션 바 */}
      {!loading && !error && entries.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs text-faint">
            전체 {entries.length}건
            {filteredEntries.length !== entries.length && (
              <span className="text-cyan-400"> → 필터 {filteredEntries.length}건</span>
            )}
            {" · "}영상 {entries.filter((e) => e.hasVideo).length}개
            {" · "}썸네일 {entries.filter((e) => e.hasThumb).length}개
            {registered.size > 0 && (
              <span className="ml-2 text-green-600">· 등록됨 {registered.size}건</span>
            )}
          </p>

          <div className="flex items-center gap-2 flex-wrap">
            {/* 오토라벨링 */}
            <AutoLabelControls
              customerId={customer.id}
              onComplete={loadDetections}
              selectedFileNames={selected.size > 0 ? Array.from(selected) : undefined}
              selectedThumbPaths={selectedThumbPaths}
            />

            {someSelected && (
              <>
                <span className="text-xs text-cyan-400">{selected.size}건 선택됨</span>
                <button
                  onClick={registerSelected}
                  disabled={registering}
                  className="px-3 py-1.5 text-xs bg-green-900/50 text-green-400 border border-green-800 rounded-lg hover:bg-green-900 disabled:opacity-40 whitespace-nowrap"
                >
                  {registering ? "등록 중..." : `✓ 등록 (${selected.size}건)`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 등록 결과 메시지 */}
      {regResult && (
        <p className={`text-xs ${regResult.ok ? "text-green-400" : "text-red-400"}`}>
          {regResult.ok ? "✓" : "✕"} {regResult.msg}
        </p>
      )}

      {/* 테이블 */}
      {filteredEntries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-faint">
                <th className="py-2 px-2 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="accent-cyan-500 cursor-pointer"
                  />
                </th>
                <th className="text-left py-2 px-2 font-medium w-16">썸네일</th>
                <th className="text-left py-2 px-2 font-medium">카메라 ID</th>
                <th className="text-left py-2 px-2 font-medium">이벤트</th>
                <th className="text-left py-2 px-2 font-medium">시작 시각</th>
                <th className="text-left py-2 px-2 font-medium w-28">파일</th>
                <th className="text-left py-2 px-2 font-medium w-24">탐지 결과</th>
                <th className="text-left py-2 px-2 font-medium w-24">라벨링 결과</th>
              </tr>
            </thead>
            <tbody>
              {pagedEntries.map((entry) => {
                const det       = detections[entry.baseName] ?? null;
                const isChecked = selected.has(entry.baseName);
                const isReg     = registered.has(entry.baseName);
                return (
                  <tr
                    key={entry.baseName}
                    className={`border-b border-line/50 hover:bg-input/20 cursor-pointer ${isChecked ? "bg-cyan-900/10" : ""}`}
                    onClick={() => toggleSelect(entry.baseName)}
                  >
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(entry.baseName)}
                        className="accent-cyan-500 cursor-pointer"
                      />
                    </td>

                    {/* 썸네일 */}
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      <div className="relative">
                        {entry.hasThumb && entry.thumbPath ? (
                          <div
                            className="w-14 h-10 rounded overflow-hidden bg-input relative cursor-zoom-in hover:opacity-80 transition-opacity"
                            onClick={() => setThumbIndex(thumbEntries.findIndex((t) => t.baseName === entry.baseName))}
                          >
                            <Image
                              src={thumbUrl(entry.thumbPath)}
                              alt="thumbnail"
                              fill
                              className="object-cover"
                              unoptimized
                            />
                          </div>
                        ) : (
                          <div className="w-14 h-10 rounded bg-input flex items-center justify-center text-faint text-[10px]">
                            없음
                          </div>
                        )}
                        {isReg && (
                          <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-green-500 border border-gray-900 flex items-center justify-center text-[8px] text-white font-bold">
                            ✓
                          </span>
                        )}
                      </div>
                    </td>

                    {/* 카메라 ID */}
                    <td className="py-2 px-2 font-mono text-ink2">
                      {entry.cameraId}
                      {isReg && (
                        <span className="ml-1 text-[9px] text-green-600 font-normal">등록됨</span>
                      )}
                    </td>

                    {/* 이벤트 */}
                    <td className="py-2 px-2 text-ink2">{entry.eventName}</td>

                    {/* 시작 시각 */}
                    <td className="py-2 px-2 font-mono text-muted whitespace-nowrap">{entry.startTime}</td>

                    {/* 파일 */}
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-col gap-1">
                        {entry.hasVideo && entry.videoPath && (
                          <a
                            href={videoUrl(entry.videoPath)}
                            download={entry.videoFileName}
                            className="px-2 py-0.5 bg-input text-cyan-400 border border-line2 rounded hover:bg-gray-700 text-[10px] whitespace-nowrap"
                          >
                            🎬 영상
                          </a>
                        )}
                        {entry.hasThumb && entry.thumbPath && (
                          <a
                            href={thumbUrl(entry.thumbPath)}
                            download={entry.thumbFileName}
                            className="px-2 py-0.5 bg-input text-amber-400 border border-line2 rounded hover:bg-gray-700 text-[10px] whitespace-nowrap"
                          >
                            🖼 썸네일
                          </a>
                        )}
                      </div>
                    </td>

                    {/* 탐지 결과 */}
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={det ?? ""}
                        disabled={savingDet === entry.baseName}
                        onChange={(e) => {
                          const val = e.target.value as "TP" | "FP" | "TN" | "FN" | "";
                          saveDetection(entry.baseName, val === "" ? null : val);
                        }}
                        className={`px-2 py-1 rounded text-[10px] border focus:outline-none ${
                          det === "TP"   ? "bg-green-900/60 border-green-700 text-green-400"
                          : det === "FP" ? "bg-red-900/60 border-red-700 text-red-400"
                          : det === "TN" ? "bg-blue-900/60 border-blue-700 text-blue-400"
                          : det === "FN" ? "bg-amber-900/60 border-amber-700 text-amber-400"
                          : "bg-input/40 border-line2 text-faint"
                        }`}
                      >
                        <option value="">미선택</option>
                        <option value="TP">TP</option>
                        <option value="FP">FP</option>
                        <option value="TN">TN</option>
                        <option value="FN">FN</option>
                      </select>
                    </td>

                    {/* 라벨링 결과 */}
                    <td className="py-2 px-2">
                      <LabelNameChip name={labelNames[entry.baseName] ?? null} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 페이지네이션 */}
      {filteredEntries.length > NAS_PAGE_SIZE && (
        <div className="flex items-center justify-center gap-1 pt-1">
          <button onClick={() => setPage(0)} disabled={page === 0}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30">«</button>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30">‹</button>

          {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            const startPage = Math.max(0, Math.min(page - 3, totalPages - 7));
            const p = startPage + i;
            return (
              <button key={p} onClick={() => setPage(p)}
                className={`px-2 py-1 text-xs rounded ${
                  p === page
                    ? "bg-cyan-800/60 text-cyan-300 border border-cyan-700"
                    : "text-faint hover:text-gray-300"
                }`}
              >
                {p + 1}
              </button>
            );
          })}

          <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30">›</button>
          <button onClick={() => setPage(totalPages - 1)} disabled={page === totalPages - 1}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30">»</button>

          <span className="text-xs text-faint ml-2">
            {page * NAS_PAGE_SIZE + 1}–{Math.min((page + 1) * NAS_PAGE_SIZE, filteredEntries.length)} / {filteredEntries.length}건
          </span>
        </div>
      )}

      {/* 빈 상태 */}
      {!loading && !error && entries.length === 0 && (
        <div className="py-8 text-center">
          <p className="text-xs text-faint">
            <code className="text-cyan-700">{customer.nasPath ?? "/rtpulse"}/{subPath}</code>
          </p>
          <p className="text-xs text-faint mt-1">조회 버튼을 눌러 NAS 파일 목록을 불러오세요.</p>
        </div>
      )}

      {!loading && !error && entries.length > 0 && filteredEntries.length === 0 && (
        <div className="py-6 text-center">
          <p className="text-xs text-faint">필터 조건에 맞는 파일이 없습니다.</p>
        </div>
      )}
    </div>
  );
}

// ─── Main DataList ────────────────────────────────────────────────────────────

export default function DataList({ customer }: Props) {
  const tz = customer.timezone ?? "Asia/Seoul";

  const [dataTab, setDataTab] = useState<"db" | "nas">("db");

  const [eventOptions, setEventOptions] = useState<string[]>([]);
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [from, setFrom] = useState(() => nDaysAgoInTz(7, tz));
  const [to, setTo] = useState(() => todayInTz(tz));
  const [limit, setLimit] = useState("500");

  const [searching, setSearching] = useState(false);
  const [rows, setRows] = useState<DataRow[]>([]);
  const [searchMsg, setSearchMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [filterText, setFilterText] = useState("");

  const [failedThumbs, setFailedThumbs] = useState<Set<number>>(new Set());
  const [nasSubPath, setNasSubPath] = useState(customer.name);
  const [filterDet, setFilterDet] = useState<"all" | "TP" | "FP" | "TN" | "FN" | "none">("all");

  // 썸네일 640×480 상세보기 — 썸네일 보유 행 목록 내 인덱스 추적 (좌/우 키 이동)
  const [thumbIndex, setThumbIndex] = useState<number | null>(null);
  const closePreview = useCallback(() => setThumbIndex(null), []);

  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);

  // 업로드 모달이 열려 있는 동안 배경 스크롤 잠금
  useEffect(() => {
    if (!showUploadModal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [showUploadModal]);
  const [downloading, setDownloading] = useState(false);

  // 자동 업로드 (서버사이드 설정)
  const [autoConfig,      setAutoConfig]      = useState<{
    enabled: boolean; intervalHours: number; nasSubPath: string;
    lastRunAt: string | null; lastResult: string | null; isRunning: boolean;
  } | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);

  // 탐지 결과 (key = String(row._id))
  const [detections,  setDetections]  = useState<Record<string, DetectionResult>>({});
  const [labelNames,  setLabelNames]  = useState<Record<string, string | null>>({});
  const [savingDet,   setSavingDet]   = useState<string | null>(null);

  const nasBase = customer.nasPath ?? "/rtpulse";
  const hasDb = !!(customer.dbPassword);

  useEffect(() => {
    if (!hasDb) return;
    fetch(`/api/db/${customer.id}/crawl`)
      .then((r) => r.json())
      .then((d) => setEventOptions(d.events ?? []))
      .catch(() => {});
  }, [customer.id, hasDb]);

  // 탐지 결과 로드
  const loadDetections = useCallback(async () => {
    try {
      const r = await fetch(`/api/nas/${customer.id}/detection-result`);
      if (r.ok) {
        const d = await r.json();
        setDetections(d.results    ?? {});
        setLabelNames(d.labelNames ?? {});
      }
    } catch { /**/ }
  }, [customer.id]);

  useEffect(() => { loadDetections(); }, [loadDetections]);

  async function saveDetection(rowId: number, result: DetectionResult) {
    const key     = String(rowId);
    const rowData = rows.find((r) => r._id === rowId);
    setSavingDet(key);
    try {
      await fetch(`/api/nas/${customer.id}/detection-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName:  key,
          result,
          eventName: rowData?.event_name,
          cameraId:  rowData ? String(rowData.camera_id) : undefined,
          eventTime: rowData?.start_time,   // UTC datetime from MySQL
        }),
      });
      setDetections((prev) => ({ ...prev, [key]: result }));
    } finally {
      setSavingDet(null);
    }
  }

  function toggleEvent(ev: string) {
    setSelectedEvents((prev) =>
      prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]
    );
  }

  function toggleRow(id: number) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const allFilteredIds = new Set(filteredRows.map((r) => r._id));
    const allSelected = filteredRows.every((r) => checkedIds.has(r._id));
    setCheckedIds(allSelected ? new Set() : allFilteredIds);
  }

  async function handleSearch() {
    setSearching(true);
    setSearchMsg(null);
    setRows([]);
    setCheckedIds(new Set());
    setFailedThumbs(new Set());
    setUploadResult(null);
    setFilterText("");
    try {
      const res = await fetch(`/api/db/${customer.id}/crawl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: selectedEvents,
          from: localDateToUtc(from, false, tz),  // 로컬 00:00:00 -> UTC
          to:   localDateToUtc(to,   true,  tz),  // 로컬 23:59:59 -> UTC
          limit: Number(limit) || 500,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSearchMsg({ text: `오류: ${data.error}`, ok: false });
      } else {
        setRows(data.rows ?? []);
        setSearchMsg({ text: `${data.total}건 조회됨`, ok: true });
      }
    } catch (e: unknown) {
      setSearchMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setSearching(false);
    }
  }

  async function handleNasUpload() {
    const selectedRows = rows.filter((r) => checkedIds.has(r._id));
    if (selectedRows.length === 0) { alert("항목을 선택하세요."); return; }
    setUploading(true);
    setShowUploadModal(true);
    setUploadResult({ ok: true, msg: "업로드 준비 중..." });

    try {
      // 1. 잡 시작 (즉시 반환)
      const res = await fetch(`/api/nas/${customer.id}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: selectedRows.map((r) => ({
            eventId:   r._id,
            cameraId:  r.camera_id,
            eventName: r.event_name,
            startTime: r.start_time,
            endTime:   r.end_time ?? null,
            thumbnail: r.thumbnail ?? null,
            videoUrl:  r.video_url ?? null,
          })),
          nasSubPath,
        }),
      });

      const rawText = await res.text();
      let startData: Record<string, unknown> | null = null;
      try { startData = JSON.parse(rawText); } catch {
        setUploadResult({ ok: false, msg: `업로드 오류: ${rawText.slice(0, 200)}` });
        return;
      }
      if (!res.ok || !startData) {
        setUploadResult({ ok: false, msg: (startData?.error as string) ?? "업로드 시작 실패" });
        return;
      }

      const { jobId } = startData as { jobId: string };

      // 2. 폴링 (3초 간격, 서버 잡이 끝날 때까지 — 60분 안전상한)
      // 대량 업로드는 10분을 훌쩍 넘길 수 있어, 예전처럼 200회(10분)에서 끊고
      // 마지막 진행문구를 '완료'로 오표시하지 않도록 함.
      const MAX_POLLS = 1200; // 3s × 1200 = 60분
      let finished = false;
      let consecutiveErr = 0;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, 3_000));
        try {
          const statusRes = await fetch(`/api/nas/${customer.id}/upload?jobId=${jobId}`);
          if (statusRes.status === 404) { // 잡 만료(1h)/프로세스 재시작으로 상태 소실
            setUploadResult({ ok: false, msg: "진행 상태를 잃었습니다 (서버 재시작 등). 서버는 업로드를 계속했을 수 있으니 NAS 목록에서 실제 결과를 확인하세요." });
            finished = true; break;
          }
          const job = await statusRes.json() as {
            status: string; progress: string;
            result?: { thumbnail: { success: number; total: number }; video: { success: number; total: number }; targetDir: string; results: { cameraId: number; startTime: string; thumbnail: { ok: boolean; error?: string } | null; video: { ok: boolean; error?: string } | null }[] };
            error?: string;
          };
          consecutiveErr = 0;

          if (job.status === "processing") {
            setUploadResult({ ok: true, msg: `⏳ ${job.progress ?? "처리 중..."}` });
            continue;
          }

          if (job.status === "error") {
            setUploadResult({ ok: false, msg: job.error ?? "업로드 실패" });
            finished = true; break;
          }

          if (job.status === "done" && job.result) {
            const { thumbnail: th, video: vi, targetDir, results } = job.result;
            const allOk = th.success === th.total && vi.success === vi.total;
            const errors: string[] = [];
            for (const r of results ?? []) {
              const tag = `카메라 ${r.cameraId} · ${new Date(r.startTime).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
              if (r.thumbnail && !r.thumbnail.ok && r.thumbnail.error) errors.push(`[${tag}] 썸네일: ${r.thumbnail.error}`);
              if (r.video     && !r.video.ok     && r.video.error)     errors.push(`[${tag}] 영상: ${r.video.error}`);
            }
            setUploadResult({
              ok: allOk,
              msg: [
                `썸네일 ${th.success}/${th.total}건  영상 ${vi.success}/${vi.total}건 완료 → ${targetDir}`,
                ...(errors.length ? [`실패 ${errors.length}건 (수동 확인용):`] : []),
                ...errors.slice(0, 10),
                ...(errors.length > 10 ? [`… 외 ${errors.length - 10}건`] : []),
              ].join("\n"),
            });
            if (allOk) setCheckedIds(new Set());
            finished = true; break;
          }
        } catch {
          // 일시적 네트워크 오류는 재시도하되, 계속 실패하면(≈1분) 중단
          if (++consecutiveErr >= 20) {
            setUploadResult({ ok: false, msg: "상태 조회가 반복 실패했습니다. 서버는 계속 업로드 중일 수 있으니 잠시 후 NAS 목록에서 확인하세요." });
            finished = true; break;
          }
        }
      }
      if (!finished) {
        // 60분 상한 도달 — 완료로 오표시하지 않음
        setUploadResult({ ok: false, msg: "⏳ 시간이 오래 걸려 실시간 표시를 중단했습니다. 서버는 계속 업로드 중일 수 있습니다 — 잠시 후 NAS 목록에서 결과를 확인하세요." });
      }
    } catch (e: unknown) {
      setUploadResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  }

  // ─── 자동 업로드 (서버사이드) ────────────────────────────────────────────────

  const loadAutoConfig = useCallback(async () => {
    try {
      const r = await fetch(`/api/nas/${customer.id}/auto-upload`);
      if (r.ok) setAutoConfig(await r.json());
    } catch { /* 무시 */ }
  }, [customer.id]);

  useEffect(() => { loadAutoConfig(); }, [loadAutoConfig]);

  // 활성화 중일 때 30초마다 상태 갱신
  useEffect(() => {
    if (!autoConfig?.enabled) return;
    const t = setInterval(loadAutoConfig, 30_000);
    return () => clearInterval(t);
  }, [autoConfig?.enabled, loadAutoConfig]);

  const saveAutoConfig = async (patch: Partial<typeof autoConfig>) => {
    if (!autoConfig) return;
    setSavingAuto(true);
    try {
      await fetch(`/api/nas/${customer.id}/auto-upload`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(patch),
      });
      setAutoConfig((prev) => prev ? { ...prev, ...patch } : prev);
    } finally {
      setSavingAuto(false);
    }
  };

  const runAutoNow = async () => {
    setSavingAuto(true);
    setAutoConfig((prev) => prev ? { ...prev, isRunning: true } : prev);
    try {
      const res = await fetch(`/api/nas/${customer.id}/auto-upload`, { method: "POST" });
      const d = await res.json() as { ok: boolean; result?: string; error?: string; count?: number };
      await loadAutoConfig();
      if (!d.ok) alert(`자동 업로드 실패: ${d.error ?? "알 수 없는 오류"}`);
    } finally {
      setSavingAuto(false);
    }
  };

  const resetAutoLastRun = async () => {
    if (!confirm("마지막 실행 시각을 초기화합니다.\n다음 실행 시 하루 전 데이터부터 재조회합니다.")) return;
    setSavingAuto(true);
    await fetch(`/api/nas/${customer.id}/auto-upload`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resetLastRunAt: true }),
    });
    await loadAutoConfig();
    setSavingAuto(false);
  };

  // 클라이언트 사이드 필터링 (텍스트 + 탐지결과)
  const PAGE_SIZE = 50;

  const filteredRows = useMemo(() => {
    let r = filterText.trim()
      ? rows.filter((row) => {
          const q = filterText.toLowerCase();
          return (
            String(row.camera_id).toLowerCase().includes(q) ||
            row.event_name.toLowerCase().includes(q)
          );
        })
      : rows;
    if (filterDet !== "all") {
      r = r.filter((row) => {
        const det = detections[String(row._id)] ?? null;
        if (filterDet === "TP")   return det === "TP";
        if (filterDet === "FP")   return det === "FP";
        if (filterDet === "TN")   return det === "TN";
        if (filterDet === "FN")   return det === "FN";
        if (filterDet === "none") return det === null;
        return true;
      });
    }
    return r;
  }, [rows, filterText, filterDet, detections]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));

  // 필터/검색 변경 시 1페이지로 복귀
  useEffect(() => { setPage(1); }, [filterText, filterDet, rows]);

  const pagedRows = useMemo(
    () => filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredRows, page],
  );

  // 썸네일 미리보기 대상(썸네일 보유 행) — 좌/우 키로 이 목록 안에서 이동
  const thumbRows = useMemo(() => filteredRows.filter((r) => r.thumbnail), [filteredRows]);
  const thumbUrlMinio = useCallback(
    (path: string) => `/api/minio/${customer.id}/thumbnail?path=${encodeURIComponent(path)}`,
    [customer.id],
  );
  const currentThumb = thumbIndex !== null ? thumbRows[thumbIndex] ?? null : null;

  // 미리보기 열려 있을 때 ← / → 로 이전·다음, 1/2 로 TP/FP 라벨링, Esc 로 닫기
  useEffect(() => {
    if (thumbIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft")       setThumbIndex((i) => (i === null ? i : Math.max(0, i - 1)));
      else if (e.key === "ArrowRight") setThumbIndex((i) => (i === null ? i : Math.min(thumbRows.length - 1, i + 1)));
      else if (e.key === "Escape")     setThumbIndex(null);
      else if (e.key === "1")          { if (currentThumb) saveDetection(currentThumb._id, "TP"); }
      else if (e.key === "2")          { if (currentThumb) saveDetection(currentThumb._id, "FP"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbIndex, thumbRows.length, currentThumb]);

  const selectedWithThumb = rows.filter((r) => checkedIds.has(r._id) && r.thumbnail).length;
  const selectedWithVideo = rows.filter((r) => checkedIds.has(r._id) && r.video_url).length;

  // 오토라벨 대상 file_name 목록 (체크된 항목이 있을 때만; 없으면 undefined → 전체 처리)
  const autoLabelFileNames = useMemo(
    () => (checkedIds.size > 0 ? Array.from(checkedIds).map(String) : undefined),
    [checkedIds],
  );

  // MinIO ZIP 다운로드 (최대 30건)
  async function handleDownloadZip() {
    const selectedRows = rows.filter((r) => checkedIds.has(r._id));
    if (selectedRows.length === 0) { alert("항목을 선택하세요."); return; }
    if (selectedRows.length > 30)  { alert("최대 30건까지 ZIP 다운로드 가능합니다."); return; }

    setDownloading(true);
    try {
      const items = selectedRows.flatMap((r) => {
        const arr = [];
        if (r.thumbnail) arr.push({
          path: r.thumbnail, bucket: "thumbnail",
          fileName: r.thumbnail.split("/").pop() ?? `thumb_${r._id}.jpg`,
          folder: `${r.camera_id}_${r.event_name}_${r._id}`,
        });
        if (r.video_url) arr.push({
          path: r.video_url, bucket: "video",
          fileName: r.video_url.split("/").pop() ?? `video_${r._id}.mp4`,
          folder: `${r.camera_id}_${r.event_name}_${r._id}`,
        });
        return arr;
      });

      const res = await fetch(`/api/minio/${customer.id}/download-zip`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ items, zipName: `${customer.id}_events` }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(`다운로드 실패: ${(d as { error?: string }).error ?? res.statusText}`);
        return;
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${customer.id}_events.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(`다운로드 오류: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="border border-line rounded-xl overflow-hidden space-y-0">

      {/* ── 탭 헤더 ── */}
      <div className="flex border-b border-line bg-panel/50 flex-wrap">
        <SubTab active={dataTab === "db"}  onClick={() => setDataTab("db")}  label="DB 이벤트" icon="🗄" />
        <SubTab active={dataTab === "nas"} onClick={() => setDataTab("nas")} label="NAS 파일"   icon="📂" />
      </div>

      {/* ── NAS 파일 탭 ── */}
      {dataTab === "nas" && (
        <div className="p-4">
          <NasBrowse customer={customer} />
        </div>
      )}

      {/* ── DB 이벤트 탭 ── */}
      {dataTab === "db" && <>

      {/* 썸네일 640×480 상세보기 모달 (←/→ 로 이전·다음 이동) */}
      {currentThumb && thumbIndex !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={closePreview}
        >
          {/* 이전 */}
          <button
            onClick={(e) => { e.stopPropagation(); setThumbIndex((i) => (i === null ? i : Math.max(0, i - 1))); }}
            disabled={thumbIndex <= 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-gray-700/80 hover:bg-gray-600 text-ink text-xl flex items-center justify-center z-10 disabled:opacity-30 disabled:cursor-not-allowed"
            title="이전 (←)"
            aria-label="이전"
          >
            ‹
          </button>

          <div
            className="relative bg-panel border border-line2 rounded-xl shadow-2xl p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closePreview}
              className="absolute -top-3 -right-3 w-7 h-7 rounded-full bg-gray-700 hover:bg-gray-600 text-ink text-sm flex items-center justify-center z-10"
            >
              ✕
            </button>
            <div className="px-2 pt-1 pb-2 text-center">
              <p className="text-sm font-semibold text-ink truncate">
                {[currentThumb.camera_id, currentThumb.event_name]
                  .filter((v) => v !== null && v !== undefined && v !== "")
                  .join(" · ")}
              </p>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbUrlMinio(currentThumb.thumbnail!)}
              alt="썸네일 상세"
              style={{ width: 640, height: 480, objectFit: "contain" }}
              className="rounded-lg bg-black"
            />
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-2.5 py-1 rounded-full bg-black/70 text-white text-[11px]">
              <span>{thumbIndex + 1} / {thumbRows.length}</span>
              <span className="opacity-40">|</span>
              {(() => {
                const cur = detections[String(currentThumb._id)] ?? null;
                return (
                  <>
                    <span className={cur === "TP" ? "text-green-400 font-semibold" : "text-white/70"}>[1] TP</span>
                    <span className={cur === "FP" ? "text-red-400 font-semibold" : "text-white/70"}>[2] FP</span>
                  </>
                );
              })()}
            </div>
          </div>

          {/* 다음 */}
          <button
            onClick={(e) => { e.stopPropagation(); setThumbIndex((i) => (i === null ? i : Math.min(thumbRows.length - 1, i + 1))); }}
            disabled={thumbIndex >= thumbRows.length - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-gray-700/80 hover:bg-gray-600 text-ink text-xl flex items-center justify-center z-10 disabled:opacity-30 disabled:cursor-not-allowed"
            title="다음 (→)"
            aria-label="다음"
          >
            ›
          </button>
        </div>
      )}

      {/* ── 크롤링 필터 ── */}
      <div className="p-4 space-y-3 border-b border-line">
        {!hasDb && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 dark:text-amber-400 dark:bg-amber-900/20 dark:border-amber-800">
            DB 비밀번호가 설정되지 않았습니다. 고객사 수정 페이지에서 DB 정보를 입력하세요.
          </p>
        )}

        {/* 이벤트 태그 */}
        <div>
          <label className="block text-xs text-faint mb-2">이벤트 유형</label>
          {eventOptions.length === 0 ? (
            <span className="text-xs text-faint">이벤트 목록 없음 — DB 초기화 후 데이터가 있어야 표시됩니다.</span>
          ) : (
            <div className="flex flex-wrap gap-2">
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
                <button
                  onClick={() => setSelectedEvents([])}
                  className="px-2.5 py-1 text-xs text-faint hover:text-muted"
                >
                  초기화
                </button>
              )}
            </div>
          )}
        </div>

        {/* 날짜 + 한도 + 크롤링 버튼 */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs text-faint shrink-0">기간</label>
            <input
              type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className={dateCls}
            />
            <span className="text-faint text-xs">~</span>
            <input
              type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className={dateCls}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-faint shrink-0">최대</label>
            <input
              type="number" value={limit} min="1" max="5000"
              onChange={(e) => setLimit(e.target.value)}
              className="w-20 px-2 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-cyan-600"
            />
            <span className="text-xs text-faint">건</span>
          </div>
          <button
            onClick={handleSearch}
            disabled={!hasDb || searching}
            className="px-4 py-1.5 text-xs bg-cyan-700 text-white rounded-lg hover:bg-cyan-600 disabled:opacity-40 font-medium"
          >
            {searching ? "검색 중…" : "검색"}
          </button>
          {searchMsg && (
            <span className={`text-xs ${searchMsg.ok ? "text-green-400" : "text-red-400"}`}>
              {searchMsg.text}
            </span>
          )}
        </div>
      </div>

      {/* ── 결과 테이블 ── */}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          {/* 테이블 상단 툴바 */}
          <div className="px-4 py-2 border-b border-line bg-panel/40 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <button onClick={toggleAll} className="text-xs text-faint hover:text-gray-300 shrink-0">
                  {checkedIds.size === rows.length ? "전체 해제" : "전체 선택"}
                </button>
                <span className="text-xs text-faint">
                  {filteredRows.length !== rows.length
                    ? `${filteredRows.length}/${rows.length}건`
                    : `${rows.length}건`}
                  {checkedIds.size > 0 && (
                    <span className="text-cyan-400 ml-1">· {checkedIds.size}건 선택됨</span>
                  )}
                </span>
              </div>
              {/* 검색 필터 */}
              <input
                type="text"
                placeholder="카메라 ID / 이벤트명 검색..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                className="px-3 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink placeholder-gray-600 focus:outline-none focus:border-cyan-600 w-52"
              />
            </div>
            {/* 탐지결과 필터 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-faint shrink-0">탐지결과:</span>
              {(["all", "TP", "FP", "TN", "FN", "none"] as const).map((f) => {
                const active = filterDet === f;
                const cls = active
                  ? f === "TP"   ? "bg-green-900/60 border-green-700 text-green-400"
                  : f === "FP"   ? "bg-red-900/60 border-red-700 text-red-400"
                  : f === "TN"   ? "bg-blue-900/60 border-blue-700 text-blue-400"
                  : f === "FN"   ? "bg-amber-900/60 border-amber-700 text-amber-400"
                  : f === "none" ? "bg-gray-700/60 border-gray-500 text-gray-300"
                  :                "bg-cyan-900/60 border-cyan-700 text-cyan-400"
                  : "bg-input/40 border-line2 text-faint hover:border-gray-500";
                return (
                  <button
                    key={f}
                    onClick={() => setFilterDet(f)}
                    className={`px-2.5 py-0.5 text-xs rounded-full border transition-colors ${cls}`}
                  >
                    {f === "all" ? "전체" : f === "none" ? "미선택" : f}
                  </button>
                );
              })}
              {/* 필터별 카운트 */}
              <span className="text-[10px] text-faint ml-1">
                {["TP", "FP", "TN", "FN", "none"].map((f) => {
                  const cnt = rows.filter((row) => {
                    const det = detections[String(row._id)] ?? null;
                    if (f === "TP")   return det === "TP";
                    if (f === "FP")   return det === "FP";
                    if (f === "TN")   return det === "TN";
                    if (f === "FN")   return det === "FN";
                    return det === null;
                  }).length;
                  return cnt > 0
                    ? <span key={f} className={`mr-2 ${f === "TP" ? "text-green-700" : f === "FP" ? "text-red-700" : f === "TN" ? "text-blue-700" : f === "FN" ? "text-amber-700" : "text-faint"}`}>
                        {f === "none" ? "미선택" : f} {cnt}
                      </span>
                    : null;
                })}
              </span>
            </div>
          </div>

          {/* 선택 액션 바 */}
          {checkedIds.size > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 bg-cyan-900/10 border-b border-line flex-wrap">
              <span className="text-xs text-cyan-400">{checkedIds.size}건 선택됨 · 썸네일 {selectedWithThumb}개 · 영상 {selectedWithVideo}개</span>
              <button
                onClick={handleDownloadZip}
                disabled={downloading || checkedIds.size > 30}
                title={checkedIds.size > 30 ? "최대 30건까지 가능합니다" : undefined}
                className="px-3 py-1 text-xs bg-blue-50 border border-blue-400 text-blue-700 rounded-lg hover:bg-blue-100 disabled:opacity-40 whitespace-nowrap dark:bg-blue-900/50 dark:text-blue-400 dark:border-blue-800 dark:hover:bg-blue-900/70"
              >
                {downloading ? "압축 중..." : `⬇ ZIP 다운로드`}
              </button>
            </div>
          )}

          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-faint bg-panel/20">
                <th className="w-8 px-3 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={filteredRows.length > 0 && filteredRows.every((r) => checkedIds.has(r._id))}
                    onChange={toggleAll}
                    className="accent-cyan-500 cursor-pointer"
                    title="전체 선택/해제"
                  />
                </th>
                <th className="px-3 py-2 text-left">썸네일</th>
                <th className="px-3 py-2 text-left">카메라 ID</th>
                <th className="px-3 py-2 text-left">이벤트</th>
                <th className="px-3 py-2 text-left">시작시각</th>
                <th className="px-3 py-2 text-left">종료시각</th>
                <th className="px-3 py-2 text-left">파일</th>
                <th className="px-3 py-2 text-left w-24">탐지 결과</th>
                <th className="px-3 py-2 text-left w-24">라벨링 결과</th>
                <th className="px-3 py-2 text-center">미디어</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((row) => {
                const det = detections[String(row._id)] ?? null;
                return (
                  <tr
                    key={row._id}
                    onClick={() => toggleRow(row._id)}
                    className={`border-b border-line/50 cursor-pointer transition-colors ${
                      checkedIds.has(row._id) ? "bg-cyan-900/10" : "hover:bg-input/30"
                    }`}
                  >
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={checkedIds.has(row._id)}
                        onChange={() => toggleRow(row._id)}
                        onClick={(e) => e.stopPropagation()}
                        className="accent-cyan-500"
                      />
                    </td>

                    {/* 썸네일 */}
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-col gap-1 items-start">
                        {row.thumbnail && !failedThumbs.has(row._id) ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`/api/minio/${customer.id}/thumbnail?path=${encodeURIComponent(row.thumbnail)}`}
                            alt="썸네일"
                            loading="lazy"
                            className="w-16 h-10 object-cover rounded bg-input cursor-zoom-in hover:opacity-80 transition-opacity"
                            onError={() => setFailedThumbs((prev) => new Set(prev).add(row._id))}
                            onClick={() => setThumbIndex(thumbRows.findIndex((r) => r._id === row._id))}
                          />
                        ) : (
                          <div className="w-16 h-10 bg-input/40 rounded flex items-center justify-center text-faint text-[10px]">
                            {row.thumbnail ? "오류" : "없음"}
                          </div>
                        )}
                        {row.thumbnail && !failedThumbs.has(row._id) && (
                          <a
                            href={`/api/minio/${customer.id}/thumbnail?path=${encodeURIComponent(row.thumbnail)}&download=1`}
                            download
                            className="text-[9px] text-amber-600 hover:text-amber-400 whitespace-nowrap"
                          >
                            🖼 저장
                          </a>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-2 text-muted font-mono">{row.camera_id}</td>
                    <td className="px-3 py-2">
                      <span className="px-2 py-0.5 bg-input text-ink2 rounded-full whitespace-nowrap">
                        {row.event_name}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-faint font-mono whitespace-nowrap">
                      {new Date(row.start_time).toLocaleString("sv-SE", { timeZone: tz, hour12: false })}
                    </td>
                    <td className="px-3 py-2 text-faint font-mono whitespace-nowrap">
                      {row.end_time ? new Date(row.end_time).toLocaleString("sv-SE", { timeZone: tz, hour12: false }) : "—"}
                    </td>

                    {/* 파일 다운로드 */}
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-col gap-1">
                        {row.video_url && (
                          <a
                            href={`/api/minio/${customer.id}/video?path=${encodeURIComponent(row.video_url)}&download=1`}
                            download
                            className="px-2 py-0.5 bg-input text-cyan-400 border border-line2 rounded hover:bg-gray-700 text-[10px] whitespace-nowrap"
                            title={row.video_url.split("/").pop()}
                          >
                            🎬 영상
                          </a>
                        )}
                      </div>
                    </td>

                    {/* 탐지 결과 */}
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={det ?? ""}
                        disabled={savingDet === String(row._id)}
                        onChange={(e) => {
                          const val = e.target.value as "TP" | "FP" | "TN" | "FN" | "";
                          saveDetection(row._id, val === "" ? null : val);
                        }}
                        className={`px-2 py-1 rounded text-[10px] border focus:outline-none ${
                          det === "TP"   ? "bg-green-900/60 border-green-700 text-green-400"
                          : det === "FP" ? "bg-red-900/60 border-red-700 text-red-400"
                          : det === "TN" ? "bg-blue-900/60 border-blue-700 text-blue-400"
                          : det === "FN" ? "bg-amber-900/60 border-amber-700 text-amber-400"
                          : "bg-input/40 border-line2 text-faint"
                        }`}
                      >
                        <option value="">미선택</option>
                        <option value="TP">TP</option>
                        <option value="FP">FP</option>
                        <option value="TN">TN</option>
                        <option value="FN">FN</option>
                      </select>
                    </td>

                    {/* 라벨링 결과 */}
                    <td className="px-3 py-2">
                      <LabelNameChip name={labelNames[String(row._id)] ?? null} />
                    </td>

                    <td className="px-3 py-2 text-center">
                      {row.is_media_exist
                        ? <span className="text-green-400">●</span>
                        : <span className="text-faint">○</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* ── 페이지네이션 ── */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-line bg-panel/30">
              <span className="text-xs text-faint">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredRows.length)} / {filteredRows.length}건
              </span>
              <div className="flex items-center gap-1">
                {/* 처음 */}
                <button
                  onClick={() => setPage(1)}
                  disabled={page === 1}
                  className="px-2 py-1 text-xs text-faint hover:text-ink disabled:opacity-30 rounded hover:bg-input transition-colors"
                  title="처음"
                >
                  «
                </button>
                {/* 이전 */}
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-2 py-1 text-xs text-faint hover:text-ink disabled:opacity-30 rounded hover:bg-input transition-colors"
                >
                  ‹
                </button>

                {/* 페이지 번호 */}
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => {
                    // 현재 페이지 ±2, 첫·끝 페이지 항상 표시
                    return p === 1 || p === totalPages || Math.abs(p - page) <= 2;
                  })
                  .reduce<(number | "…")[]>((acc, p, idx, arr) => {
                    if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push("…");
                    acc.push(p);
                    return acc;
                  }, [])
                  .map((p, idx) =>
                    p === "…" ? (
                      <span key={`ellipsis-${idx}`} className="px-1 text-xs text-faint">…</span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        className={`min-w-[28px] px-2 py-1 text-xs rounded transition-colors ${
                          page === p
                            ? "bg-cyan-700 text-white font-medium"
                            : "text-faint hover:text-ink hover:bg-input"
                        }`}
                      >
                        {p}
                      </button>
                    )
                  )}

                {/* 다음 */}
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-2 py-1 text-xs text-faint hover:text-ink disabled:opacity-30 rounded hover:bg-input transition-colors"
                >
                  ›
                </button>
                {/* 끝 */}
                <button
                  onClick={() => setPage(totalPages)}
                  disabled={page === totalPages}
                  className="px-2 py-1 text-xs text-faint hover:text-ink disabled:opacity-30 rounded hover:bg-input transition-colors"
                  title="끝"
                >
                  »
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Auto Labeling ── */}
      <div className={`px-4 py-3 flex items-center gap-3 flex-wrap ${rows.length > 0 ? "border-t border-line bg-panel/20" : ""}`}>
        <AutoLabelControls
          customerId={customer.id}
          onComplete={loadDetections}
          selectedFileNames={autoLabelFileNames}
        />
      </div>

      {/* ── NAS 업로드 ── */}
      <div className="p-4 space-y-3 border-t border-line bg-panel/20">

        {/* 자동 업로드 토글 (서버사이드 스케줄) */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-faint shrink-0">자동 업로드</span>

          {/* 토글 스위치 */}
          <button
            onClick={() => saveAutoConfig({ enabled: !autoConfig?.enabled })}
            disabled={savingAuto || !autoConfig}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              autoConfig?.enabled ? "bg-cyan-600" : "bg-gray-600"
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
              autoConfig?.enabled ? "translate-x-[18px]" : "translate-x-[3px]"
            }`} />
          </button>

          {autoConfig?.enabled && (
            <select
              value={String(autoConfig.intervalHours)}
              onChange={(e) => saveAutoConfig({ intervalHours: Number(e.target.value) })}
              className="px-2 py-1 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-cyan-600"
            >
              <option value="1">1시간마다</option>
              <option value="2">2시간마다</option>
              <option value="3">3시간마다</option>
              <option value="4">4시간마다</option>
            </select>
          )}

          {/* 지금 실행 버튼 */}
          {autoConfig?.enabled && !autoConfig.isRunning && (
            <button
              onClick={runAutoNow}
              disabled={savingAuto}
              className="px-2.5 py-1 text-[11px] rounded-md border border-cyan-800 text-cyan-400 hover:bg-cyan-900/30 disabled:opacity-40 transition-colors"
            >
              ▶ 지금 실행
            </button>
          )}

          {/* 초기화 버튼 — lastRunAt 리셋 */}
          {autoConfig?.enabled && !autoConfig.isRunning && autoConfig.lastRunAt && (
            <button
              onClick={resetAutoLastRun}
              disabled={savingAuto}
              className="px-2.5 py-1 text-[11px] rounded-md border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500 disabled:opacity-40 transition-colors"
              title="마지막 실행 시각 초기화 — 다음 실행 시 재조회"
            >
              ↺ 초기화
            </button>
          )}

          {/* 상태: 마지막 실행 결과 */}
          {autoConfig?.enabled && (
            <span className={`text-xs ${
              autoConfig.isRunning
                ? "text-cyan-400 animate-pulse"
                : autoConfig.lastResult?.includes("오류") || autoConfig.lastResult?.includes("타임아웃")
                  ? "text-red-400"
                  : "text-faint"
            }`}>
              {autoConfig.isRunning
                ? "⏳ 업로드 진행 중..."
                : autoConfig.lastRunAt
                  ? `${new Date(autoConfig.lastRunAt).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} — ${autoConfig.lastResult ?? ""}`
                  : "아직 실행 안 됨"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-xs text-faint shrink-0">하위 경로</label>
          <input
            value={nasSubPath}
            onChange={(e) => setNasSubPath(e.target.value)}
            placeholder="예: 2024-06/이상행동"
            className="flex-1 max-w-xs px-3 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink placeholder-gray-600 focus:outline-none focus:border-cyan-600"
          />
          <span className="text-xs text-faint font-mono shrink-0">
            → {nasBase}/{nasSubPath || "…"}
          </span>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleNasUpload}
            disabled={uploading || checkedIds.size === 0}
            className="px-4 py-1.5 text-xs bg-input text-cyan-400 border border-cyan-800 rounded-lg hover:bg-gray-700 disabled:opacity-40 font-medium"
          >
            {uploading ? "업로드 중…" : "NAS 업로드"}
          </button>

          {checkedIds.size > 0 && (
            <span className="text-xs text-faint">
              {checkedIds.size}건 선택
              <span className="text-muted"> · 썸네일 {selectedWithThumb}건 · 영상 {selectedWithVideo}건</span>
            </span>
          )}

          {uploadResult && (
            <span className={`text-xs whitespace-pre-line ${uploadResult.ok ? "text-green-400" : "text-red-400"}`}>
              {uploadResult.msg}
            </span>
          )}
        </div>
      </div>

      </> /* end dataTab === "db" */}

      {/* ── NAS 업로드 진행 모달 (완료까지 화면 차단) ───────────────────────── */}
      {showUploadModal && (() => {
        const m = uploadResult?.msg ?? "";
        const mm = m.match(/(\d+)\s*\/\s*(\d+)/);
        const pct = uploading && mm && Number(mm[2]) > 0
          ? Math.min(Math.round((Number(mm[1]) / Number(mm[2])) * 100), 100)
          : uploading ? null : 100;
        return (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="w-[92vw] max-w-lg bg-panel border border-line2 rounded-2xl shadow-2xl p-8 space-y-6">
              {uploading ? (
                <>
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-line2 border-t-cyan-500 rounded-full animate-spin" />
                    <h2 className="text-xl font-bold text-ink">NAS 업로드 진행 중</h2>
                    <p className="text-base text-cyan-400 text-center break-keep min-h-[3rem] flex items-center">
                      {m.replace(/^⏳\s*/, "") || "업로드 준비 중…"}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <div className="w-full h-3 bg-input rounded-full overflow-hidden">
                      <div
                        className={`h-full bg-cyan-500 rounded-full transition-all duration-300 ${pct === null ? "animate-pulse w-1/3" : ""}`}
                        style={pct === null ? undefined : { width: `${pct}%` }}
                      />
                    </div>
                    {pct !== null && <p className="text-right text-sm font-mono text-muted">{pct}%</p>}
                  </div>
                  <p className="text-sm text-amber-400 text-center font-medium">
                    ⚠ 완료될 때까지 이 창을 닫지 마세요.
                  </p>
                </>
              ) : (
                <>
                  <div className="flex flex-col items-center gap-3">
                    <div className={`text-4xl ${uploadResult?.ok ? "text-green-400" : "text-red-400"}`}>
                      {uploadResult?.ok ? "✓" : "✕"}
                    </div>
                    <h2 className="text-xl font-bold text-ink">
                      {uploadResult?.ok ? "업로드 완료" : "업로드 실패"}
                    </h2>
                  </div>
                  <p className={`text-sm whitespace-pre-line break-all max-h-[40vh] overflow-y-auto ${uploadResult?.ok ? "text-muted text-center" : "text-red-400 text-left"}`}>
                    {(uploadResult?.msg ?? "").replace(/^⏳\s*/, "")}
                  </p>
                  <button
                    onClick={() => setShowUploadModal(false)}
                    className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-semibold"
                  >
                    확인
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })()}

    </div>
  );
}

const dateCls = "px-2 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-cyan-600";
