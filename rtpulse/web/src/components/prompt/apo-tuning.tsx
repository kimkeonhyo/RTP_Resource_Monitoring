"use client";

import { useState, useEffect, useRef } from "react";
import type { ApoDbTab } from "./apo-config";

// ─── Types ────────────────────────────────────────────────────────────────────

type ModelSize  = "1B" | "3B";
type RepeatCnt  = "1" | "3" | "5" | "7" | "auto";
type PeCategory = "falldown_fire_smoke" | "esfalldown";

interface TuningConfig {
  savePath:       string;
  jsonPath:       string;
  peCategory:     PeCategory;
  minPromptKeep:  number;
  repeatCount:    RepeatCnt;
  modelSize:      ModelSize;
}

interface SummaryRow {
  Version:  string;
  TP:       number;
  FP:       number;
  FN:       number;
  TN:       number;
  Total:    number;
  "1-FPR":  number;
  F1:       number;
  Acc:      number;
  HitRate:  number;
}

/** 진행 중: 각 값이 단일 객체 / 완료 후: 전체 epoch 배열 */
type SummaryValue = SummaryRow | SummaryRow[];

interface SummaryType {
  all:     SummaryValue;
  dataset: SummaryValue;
  dbGen:   SummaryValue;
  dbTest:  SummaryValue;
}

/** SSE 이벤트 페이로드 */
interface SseData {
  progress?:  number;
  status?:    string;
  epoch?:     number;
  isBest?:    boolean;
  summaries?: SummaryType;
  done?:      boolean;
  error?:     string;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-input/20 border border-line rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-base">{icon}</span>
        <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-faint">{label}</label>
      <div className="bg-input/50 border border-line rounded-lg px-3 py-2 text-xs text-ink2 font-mono select-all truncate">
        {value || <span className="text-faint opacity-50">—</span>}
      </div>
    </div>
  );
}

const SUMMARY_COLS: (keyof SummaryRow)[] = [
  "Version", "TP", "FP", "FN", "TN", "Total", "1-FPR", "F1", "Acc", "HitRate",
];

/** 진행 중(단일 row) 또는 완료 후(배열) 모두 처리하는 summaries 테이블 */
function SummaryTable({
  label,
  value,
  bestVersion,
}: {
  label:       string;
  value:       SummaryValue | undefined;
  bestVersion: string | undefined;
}) {
  if (!value) return null;

  const rows: SummaryRow[] = Array.isArray(value) ? value : [value];

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">{label}</p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-input/70 text-[10px] text-muted uppercase tracking-wider">
              {SUMMARY_COLS.map((col) => (
                <th key={col} className="px-2.5 py-2 text-left font-medium whitespace-nowrap">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row, i) => {
              const isBestRow = bestVersion !== undefined && row.Version === bestVersion;
              return (
                <tr
                  key={i}
                  className={`transition-colors ${
                    isBestRow
                      ? "bg-amber-900/25 border-l-2 border-amber-500"
                      : "hover:bg-input/30"
                  }`}
                >
                  {SUMMARY_COLS.map((col) => {
                    const raw = row[col];
                    const isNumFrac = col === "1-FPR" || col === "F1" || col === "Acc" || col === "HitRate";
                    const display  = isNumFrac && typeof raw === "number"
                      ? raw.toFixed(3)
                      : String(raw ?? "—");
                    return (
                      <td
                        key={col}
                        className={`px-2.5 py-2 font-mono whitespace-nowrap ${
                          col === "Version"
                            ? isBestRow ? "text-amber-300 font-semibold" : "text-ink2"
                            : "text-ink2"
                        }`}
                      >
                        {col === "Version" && isBestRow
                          ? <span className="flex items-center gap-1">{display} <span className="text-amber-400 text-[9px]">BEST</span></span>
                          : display}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ApoTuning({
  connTab,
  onBack,
}: {
  connTab: ApoDbTab;
  onBack:  () => void;
}) {
  // ── 설정값 ──────────────────────────────────────────────────────────────────
  const [config, setConfig] = useState<TuningConfig>({
    savePath:      "",
    jsonPath:      "",
    peCategory:    "falldown_fire_smoke",
    minPromptKeep: 10000, // APO 명세 기본값(구 예시 5는 결과가 크게 달라짐)
    repeatCount:   "3",
    modelSize:     "1B",
  });

  // ── 실행 상태 ────────────────────────────────────────────────────────────────
  const [running,     setRunning]     = useState(false);
  const [progress,    setProgress]    = useState(0);
  const [statusMsg,   setStatusMsg]   = useState("");
  const [currentEpoch, setCurrentEpoch] = useState<number | undefined>(undefined);
  const [summaries,   setSummaries]   = useState<SummaryType | undefined>(undefined);
  const [bestVersion, setBestVersion] = useState<string | undefined>(undefined);
  const [isDone,      setIsDone]      = useState(false);
  const [error,       setError]       = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // ── localStorage 복원 ────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const s = localStorage.getItem("apo-vms-config");
      if (s) {
        const parsed = JSON.parse(s);
        setConfig((prev) => ({
          ...prev,
          savePath: parsed.savePath ?? "",
          jsonPath: parsed.jsonPath ?? "",
        }));
      }
    } catch { /* ignore */ }
  }, []);

  const set = <K extends keyof TuningConfig>(key: K) => (val: TuningConfig[K]) =>
    setConfig((p) => ({ ...p, [key]: val }));

  // ── 튜닝 시작 ────────────────────────────────────────────────────────────────
  const handleStart = async () => {
    setRunning(true);
    setError("");
    setProgress(0);
    setStatusMsg("튜닝 준비 중...");
    setSummaries(undefined);
    setBestVersion(undefined);
    setCurrentEpoch(undefined);
    setIsDone(false);
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/apo/tuning-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
        signal: abortRef.current.signal,
      });

      if (res.status === 409) {
        throw new Error("이미 다른 튜닝 작업이 진행 중입니다. 완료 후 다시 시도하세요.");
      }
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({})) as {
          detail?: { error?: { message?: string } };
          error?: string;
        };
        throw new Error(
          err.detail?.error?.message ??
          err.error ??
          "튜닝 요청 실패"
        );
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6)) as SseData;

            // done:true + error → 튜닝 실패 (명세: TUNING_FAILED)
            if (data.done && data.error) {
              const msg = typeof data.error === "object"
                ? (data.error as { message?: string }).message ?? "튜닝 실패"
                : String(data.error);
              throw new Error(msg);
            }
            if (data.progress  !== undefined) setProgress(data.progress);
            if (data.status    !== undefined) setStatusMsg(data.status);
            if (data.epoch     !== undefined) setCurrentEpoch(data.epoch);
            if (data.summaries !== undefined) {
              setSummaries(data.summaries);
              // isBest=true 인 epoch의 Version 추적
              if (data.isBest && data.summaries.all) {
                const allVal = data.summaries.all;
                const row = Array.isArray(allVal) ? allVal[allVal.length - 1] : allVal;
                if (row?.Version) setBestVersion(row.Version);
              }
            }
            if (data.done) {
              setProgress(100);
              setStatusMsg("튜닝 완료");
              setIsDone(true);
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setStatusMsg("튜닝이 중단되었습니다.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setStatusMsg("오류 발생");
      }
    } finally {
      setRunning(false);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setRunning(false);
    setStatusMsg("중단됨");
  };

  // ── 파일 다운로드 ─────────────────────────────────────────────────────────────
  const handleDownload = async () => {
    try {
      const res = await fetch("/api/apo/best-text-features");
      if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = "Best_text_features.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("다운로드 실패: " + String(e));
    }
  };

  void connTab; // prop 사용 표시 (향후 확장 대비)

  return (
    <div className="max-w-3xl mx-auto space-y-5">

      {/* 헤더 */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted hover:text-ink transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          이전
        </button>
        <div className="flex-1">
          <h2 className="text-sm font-bold text-ink">튜닝 설정</h2>
          <p className="text-xs text-faint mt-0.5">라벨링·검수 완료 후 모델을 파인튜닝합니다.</p>
        </div>
      </div>

      {/* ── 경로 설정 ── */}
      <SectionCard title="경로 설정" icon="📁">
        <div className="grid grid-cols-1 gap-3">
          <ReadField label="저장 경로" value={config.savePath} />
          <ReadField label="JSON 경로" value={config.jsonPath} />
        </div>
        <p className="text-[10px] text-faint opacity-60 leading-relaxed">
          DB 설정 페이지에서 입력한 경로를 그대로 사용합니다. 변경이 필요하면 DB 설정으로 돌아가세요.
        </p>
      </SectionCard>

      {/* ── 튜닝 파라미터 ── */}
      <SectionCard title="튜닝 파라미터" icon="⚙️">

        {/* PE 카테고리 */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-faint">PE 카테고리</label>
          <select
            value={config.peCategory}
            onChange={(e) => set("peCategory")(e.target.value as PeCategory)}
            disabled={running}
            className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-ink focus:outline-none focus:border-blue-600 transition-colors disabled:opacity-50"
          >
            <option value="falldown_fire_smoke">falldown_fire_smoke</option>
            <option value="esfalldown">esfalldown</option>
          </select>
        </div>

        {/* 프롬프트 최소 보존 개수 */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-faint">프롬프트 최소 보존 개수</label>
          <input
            type="number"
            min={1}
            value={config.minPromptKeep}
            onChange={(e) => set("minPromptKeep")(Number(e.target.value))}
            disabled={running}
            className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-ink focus:outline-none focus:border-blue-600 transition-colors disabled:opacity-50 w-32"
          />
          <p className="text-[10px] text-faint opacity-60">
            튜닝 시 보존할 기존 프롬프트의 최소 개수 (APO 기본값 10000)
          </p>
        </div>

        {/* 반복 횟수 */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-faint">반복 횟수</label>
          <div className="flex gap-2 flex-wrap">
            {(["1", "3", "5", "7", "auto"] as RepeatCnt[]).map((v) => (
              <button
                key={v}
                onClick={() => set("repeatCount")(v)}
                disabled={running}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                  config.repeatCount === v
                    ? "bg-blue-700 border-blue-600 text-white"
                    : "bg-input border-line2 text-muted hover:text-ink hover:border-gray-500"
                }`}
              >
                {v === "auto" ? "auto" : `${v}회`}
              </button>
            ))}
          </div>
        </div>

        {/* 생성 모델 */}
        <div className="flex flex-col gap-2">
          <label className="text-xs text-faint">생성 모델</label>
          <div className="grid grid-cols-2 gap-3">
            {(["1B", "3B"] as ModelSize[]).map((m) => {
              const isSelected = config.modelSize === m;
              return (
                <button
                  key={m}
                  onClick={() => set("modelSize")(m)}
                  disabled={running}
                  className={`relative flex flex-col items-start gap-1.5 px-4 py-3.5 rounded-xl border-2 transition-all disabled:opacity-50 text-left ${
                    isSelected
                      ? "border-blue-600 bg-blue-900/25"
                      : "border-line2 bg-input/40 hover:border-gray-500"
                  }`}
                >
                  <div className="flex items-center gap-2 w-full">
                    <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                      isSelected ? "border-blue-500" : "border-gray-500"
                    }`}>
                      {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />}
                    </div>
                    <span className={`text-sm font-bold ${isSelected ? "text-blue-300" : "text-ink"}`}>
                      {m}
                    </span>
                    <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      m === "1B"
                        ? "bg-green-900/40 text-green-400"
                        : "bg-amber-900/40 text-amber-400"
                    }`}>
                      {m === "1B" ? "빠름" : "느림"}
                    </span>
                  </div>
                  <p className="text-[11px] text-faint pl-5">
                    {m === "1B"
                      ? "경량 모델 · 빠른 튜닝 · 낮은 리소스"
                      : "고성능 모델 · 높은 정확도 · 높은 리소스"}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </SectionCard>

      {/* ── 진행 상태 ── */}
      {(running || statusMsg) && (
        <SectionCard title="진행 상태" icon="⏳">
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint">
                {statusMsg}
                {currentEpoch !== undefined && (
                  <span className="ml-2 text-blue-400 font-mono">epoch {currentEpoch}</span>
                )}
              </span>
              <span className="font-mono text-ink2">{progress}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-input border border-line overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  isDone ? "bg-green-500" : "bg-blue-500"
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </SectionCard>
      )}

      {/* 에러 */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-900/20 border border-red-800/40 text-xs text-red-400">
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {error}
        </div>
      )}

      {/* ── 튜닝 결과 ── */}
      {summaries && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-muted uppercase tracking-wider px-1">
              튜닝 결과
              {isDone
                ? <span className="ml-2 text-green-400 font-normal normal-case">전체 epoch</span>
                : <span className="ml-2 text-blue-400 font-normal normal-case">진행 중 (epoch {currentEpoch})</span>}
            </h3>

            {/* 다운로드 버튼 (완료 후) */}
            {isDone && (
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-amber-700 hover:bg-amber-600 text-white font-medium rounded-lg transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Best_text_features.json
              </button>
            )}
          </div>

          <div className="bg-input/20 border border-line rounded-xl p-4 space-y-5">
            <SummaryTable label="All"     value={summaries.all}     bestVersion={bestVersion} />
            <SummaryTable label="Dataset" value={summaries.dataset} bestVersion={bestVersion} />
            <SummaryTable label="DB Gen"  value={summaries.dbGen}   bestVersion={bestVersion} />
            <SummaryTable label="DB Test" value={summaries.dbTest}  bestVersion={bestVersion} />
          </div>
        </div>
      )}

      {/* ── 액션 버튼 ── */}
      <div className="flex items-center gap-3 pt-1 pb-6">
        <button
          onClick={handleStart}
          disabled={running}
          className="flex items-center gap-2 px-7 py-2.5 rounded-lg text-xs bg-blue-700 hover:bg-blue-600 text-white font-semibold transition-colors disabled:opacity-50"
        >
          {running ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              튜닝 중...
            </>
          ) : "튜닝 시작"}
        </button>

        {running && (
          <button
            onClick={handleStop}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs bg-red-800/80 hover:bg-red-700 text-white font-semibold transition-colors"
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            종료
          </button>
        )}


      </div>
    </div>
  );
}
