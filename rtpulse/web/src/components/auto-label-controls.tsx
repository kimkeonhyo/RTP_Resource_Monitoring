"use client";

/**
 * AutoLabelControls
 * - 고객사별 오토라벨링 활성화 토글 (site_settings: auto_label__{customerId})
 * - 수동 즉시 실행 버튼 (POST /api/auto-label/{customerId})
 *
 * ⚠️  키에 콜론(:)이 들어가면 Caddy가 URL을 잘못 파싱하므로
 *     구분자를 __(더블 언더스코어)로 사용합니다.
 */

import { useState, useEffect, useCallback } from "react";

interface Props {
  customerId: string;
  /** 오토라벨 완료 후 호출 — 부모가 탐지결과 목록 새로고침에 사용 */
  onComplete?: () => void;
  /** 지정 시 해당 file_name(또는 _id)만 처리. 미지정 시 전체 미라벨 이벤트 처리. */
  selectedFileNames?: string[];
  /**
   * baseName → NAS 절대 경로 맵.
   * 제공 시 event_registrations DB 조회 없이 SFTP로 썸네일을 직접 읽어 라벨링.
   * NasList(업로드 완료 탭)처럼 아직 등록되지 않은 NAS 파일을 처리할 때 사용.
   */
  selectedThumbPaths?: Record<string, string>;
}

interface RunResult {
  totalProcessed: number;
  totalErrors:    number;
  tp:             number;
  fp:             number;
}

// 콜론(:) 대신 __ 사용 — URL 경로에 안전
const SETTINGS_KEY = (id: string) => `auto_label__${id}`;

export default function AutoLabelControls({ customerId, onComplete, selectedFileNames, selectedThumbPaths }: Props) {
  const [enabled,  setEnabled]  = useState(false);
  const [loading,  setLoading]  = useState(true);   // 초기 설정 로드
  const [toggling, setToggling] = useState(false);  // 토글 저장 중
  const [running,  setRunning]  = useState(false);  // 수동 실행 중
  const [result,   setResult]   = useState<RunResult | null>(null);
  const [errMsg,   setErrMsg]   = useState<string | null>(null);
  const [elapsed,  setElapsed]  = useState(0);      // 실행 경과 초

  /* ── 설정 로드 ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    setLoading(true);
    const key = SETTINGS_KEY(customerId);
    fetch(`/api/site-settings/${encodeURIComponent(key)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { value: string | null } | null) => {
        setEnabled(d?.value === "true");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [customerId]);

  /* ── 경과 시간 타이머 ────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const t = setInterval(() => setElapsed((s) => s + 1), 1_000);
    return () => clearInterval(t);
  }, [running]);

  /* ── 토글 저장 ─────────────────────────────────────────────────────────── */
  const handleToggle = useCallback(async () => {
    const next = !enabled;
    setToggling(true);
    // 낙관적 업데이트 — 먼저 UI 반영
    setEnabled(next);
    try {
      const key = SETTINGS_KEY(customerId);
      const res = await fetch(`/api/site-settings/${encodeURIComponent(key)}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ value: next ? "true" : "false" }),
      });
      if (!res.ok) throw new Error("저장 실패");
    } catch {
      // 저장 실패 시 원상복구
      setEnabled(!next);
    } finally {
      setToggling(false);
    }
  }, [enabled, customerId]);

  /* ── 수동 실행 ─────────────────────────────────────────────────────────── */
  const handleRun = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setErrMsg(null);
    try {
      const body: Record<string, unknown> = {};
      if (selectedFileNames && selectedFileNames.length > 0) {
        body.fileNames = selectedFileNames;
      }
      if (selectedThumbPaths && Object.keys(selectedThumbPaths).length > 0) {
        body.thumbPaths = selectedThumbPaths;
      }
      const res  = await fetch(`/api/auto-label/${customerId}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await res.json() as {
        ok:               boolean;
        totalProcessed?:  number;
        totalErrors?:     number;
        summaries?:       { tp: number; fp: number }[];
        error?:           string;
      };
      if (!res.ok || !data.ok) {
        setErrMsg(data.error ?? `오류 (${res.status})`);
      } else {
        const tp = data.summaries?.reduce((s, r) => s + r.tp, 0) ?? 0;
        const fp = data.summaries?.reduce((s, r) => s + r.fp, 0) ?? 0;
        setResult({
          totalProcessed: data.totalProcessed ?? 0,
          totalErrors:    data.totalErrors    ?? 0,
          tp,
          fp,
        });
        // 완료 후 부모에게 탐지결과 새로고침 요청
        onComplete?.();
      }
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "네트워크 오류");
    } finally {
      setRunning(false);
    }
  }, [customerId, selectedFileNames, selectedThumbPaths, onComplete]);

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* 라벨 */}
      <span className="text-xs text-faint shrink-0 flex items-center gap-1">
        🤖 Auto Labeling
      </span>

      {/* 활성화 토글 */}
      <button
        onClick={handleToggle}
        disabled={loading || toggling}
        title={enabled ? "오토라벨링 비활성화" : "오토라벨링 활성화 (4시간마다 자동 실행)"}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-40 ${
          enabled ? "bg-cyan-600" : "bg-gray-700"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${
            enabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      <span className={`text-xs shrink-0 ${enabled ? "text-cyan-400" : "text-faint"}`}>
        {loading ? "…" : enabled ? "활성화" : "비활성화"}
      </span>

      {/* 수동 실행 버튼 */}
      <button
        onClick={handleRun}
        disabled={running}
        title={
          selectedFileNames && selectedFileNames.length > 0
            ? `선택된 ${selectedFileNames.length}건만 오토라벨링`
            : "미라벨 이벤트 전체 오토라벨링"
        }
        className="flex items-center gap-1 px-3 py-1 text-xs bg-input text-purple-400 border border-purple-900 rounded-lg hover:bg-purple-900/20 disabled:opacity-40 whitespace-nowrap transition-colors"
      >
        {running ? (
          <>
            <span className="inline-block w-3 h-3 border border-purple-400 border-t-transparent rounded-full animate-spin" />
            실행 중… {elapsed > 0 && <span className="text-faint ml-0.5">{elapsed}s</span>}
          </>
        ) : (
          <>
            ▶ 지금 실행
            {selectedFileNames && selectedFileNames.length > 0 && (
              <span className="text-purple-600 ml-1">({selectedFileNames.length}건)</span>
            )}
          </>
        )}
      </button>

      {/* 결과 메시지 */}
      {result && !running && (
        <span className="text-xs text-muted">
          {result.totalProcessed === 0 ? (
            <span className="text-faint">라벨링할 이벤트 없음</span>
          ) : (
            <>
              완료 ·{" "}
              <span className="text-green-400">TP {result.tp}</span>
              {" / "}
              <span className="text-red-400">FP {result.fp}</span>
              {result.totalErrors > 0 && (
                <span className="text-amber-400"> · 오류 {result.totalErrors}</span>
              )}
            </>
          )}
        </span>
      )}
      {errMsg && !running && (
        <span className="text-xs text-red-400" title={errMsg}>
          ✕ {errMsg.slice(0, 60)}
        </span>
      )}
    </div>
  );
}
