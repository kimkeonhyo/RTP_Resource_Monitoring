"use client";

import { useRef, useState, useCallback, useEffect } from "react";

type ConvertMode = "idle" | "loading" | "done" | "error";

/** Flask와 동일한 진행률 애니메이션: 60초 동안 0→92%, 완료 시 100% */
function useConvertProgress(active: boolean) {
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (active) {
      startRef.current = performance.now();
      const tick = (now: number) => {
        const t = Math.min((now - startRef.current) / 60_000, 1);
        const pct = Math.round(92 * (1 - Math.pow(1 - t, 0.35)));
        setProgress(pct);
        if (t < 1) rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setProgress(0);
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [active]);

  const finish = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setProgress(100);
  }, []);

  return { progress, finish };
}

const REQUIRED_COLS = ["ID", "class", "prompt"] as const;

/** CSV 헤더만 빠르게 읽어서 컬럼 목록 반환 */
function readCsvHeaders(text: string): string[] {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  // 따옴표 안 콤마 처리
  const headers: string[] = [];
  let inQuote = false;
  let cur = "";
  for (const ch of firstLine) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === "," && !inQuote) { headers.push(cur.trim()); cur = ""; }
    else { cur += ch; }
  }
  headers.push(cur.trim());
  return headers;
}

export default function CsvToJsonSection() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [includePrompt, setIncludePrompt] = useState(true);
  const [mode, setMode] = useState<ConvertMode>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [resultBlobUrl, setResultBlobUrl] = useState<string | null>(null);
  const [resultCount, setResultCount] = useState(0);
  const { progress, finish: finishProgress } = useConvertProgress(mode === "loading");

  // ── 파일 선택 ──────────────────────────────────────────────────────────────

  const readFile = useCallback((f: File) => {
    if (!f.name.toLowerCase().endsWith(".csv")) {
      setErrorMsg("CSV 파일(.csv)만 지원합니다.");
      setMode("error");
      return;
    }
    setFile(f);
    setMode("idle");
    setResultBlobUrl(null);
    setErrorMsg("");

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const hdrs = readCsvHeaders(text);
      setHeaders(hdrs);
      // 행 수 (헤더 제외)
      const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
      setRowCount(Math.max(0, lines.length - 1));
    };
    reader.readAsText(f, "utf-8");
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) readFile(f);
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) readFile(f);
  };

  // ── 변환 실행 ──────────────────────────────────────────────────────────────

  const missingCols = REQUIRED_COLS.filter((c) => !headers.includes(c));
  const canConvert = file !== null && missingCols.length === 0;

  const handleConvert = async () => {
    if (!file || !canConvert) return;
    setMode("loading");
    setErrorMsg("");
    setResultBlobUrl(null);

    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("includePrompt", includePrompt ? "true" : "false");

      const res = await fetch("/api/prompt-records/csv-to-json", {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `서버 오류 (${res.status})`);
      }

      // 대용량 JSON을 JSON.parse() 없이 Blob으로 직접 다운로드
      const rowCount = parseInt(res.headers.get("X-Row-Count") ?? "0", 10);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);

      finishProgress();
      setResultCount(rowCount);
      setResultBlobUrl(blobUrl);
      setMode("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setMode("error");
    }
  };

  // ── 다운로드 ───────────────────────────────────────────────────────────────

  const handleDownload = () => {
    if (!resultBlobUrl) return;
    const a = document.createElement("a");
    a.href = resultBlobUrl;
    a.download = (file?.name.replace(/\.csv$/i, "") ?? "converted") + ".json";
    a.click();
  };

  // ── 렌더 ───────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* 헤더 */}
      <div>
        <h2 className="text-sm font-semibold text-ink mb-1">CSV → JSON 변환</h2>
        <p className="text-xs text-faint">
          프롬프트 CSV를 PE-Core 모델로 인코딩하여 feature 벡터가 포함된 JSON으로 변환합니다.
        </p>
      </div>

      {/* 드래그 & 드롭 */}
      <div
        className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          dragging
            ? "border-cyan-500 bg-cyan-500/5"
            : "border-line2 hover:border-gray-600 bg-panel/30"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={onFileChange}
        />
        {file ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-cyan-400">{file.name}</p>
            <p className="text-xs text-faint">
              {rowCount.toLocaleString()} 행 · {(file.size / 1024).toFixed(1)} KB
            </p>
            <p className="text-xs text-faint mt-2">클릭하여 파일 변경</p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-3xl text-faint">📂</p>
            <p className="text-sm text-muted">CSV 파일을 드래그하거나 클릭하여 선택</p>
            <p className="text-xs text-faint">필수 컬럼: ID, class, prompt</p>
          </div>
        )}
      </div>

      {/* 컬럼 감지 */}
      {file && headers.length > 0 && (
        <div className="bg-panel/50 border border-line rounded-xl p-4 space-y-2">
          <p className="text-xs font-medium text-muted">컬럼 감지</p>
          <div className="flex flex-wrap gap-2">
            {REQUIRED_COLS.map((col) => {
              const ok = headers.includes(col);
              return (
                <span
                  key={col}
                  className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-mono ${
                    ok
                      ? "bg-emerald-900/40 text-emerald-400 border border-emerald-800/60"
                      : "bg-red-900/40 text-red-400 border border-red-800/60"
                  }`}
                >
                  {ok ? "✓" : "✗"} {col}
                </span>
              );
            })}
          </div>
          {missingCols.length > 0 && (
            <p className="text-xs text-red-400">필수 컬럼 누락: {missingCols.join(", ")}</p>
          )}
        </div>
      )}

      {/* 출력 옵션 */}
      {file && missingCols.length === 0 && (
        <div className="bg-panel/50 border border-line rounded-xl p-4">
          <p className="text-xs font-medium text-muted mb-3">출력 옵션</p>
          <div className="flex gap-3">
            <button
              onClick={() => setIncludePrompt(true)}
              className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${
                includePrompt
                  ? "bg-cyan-600/20 border-cyan-600/50 text-cyan-400"
                  : "bg-input/50 border-line2 text-faint hover:text-gray-300"
              }`}
            >
              prompt 포함
              <span className="block text-faint font-normal text-[10px] mt-0.5">
                &quot;prompt&quot;: &quot;...&quot;
              </span>
            </button>
            <button
              onClick={() => setIncludePrompt(false)}
              className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${
                !includePrompt
                  ? "bg-cyan-600/20 border-cyan-600/50 text-cyan-400"
                  : "bg-input/50 border-line2 text-faint hover:text-gray-300"
              }`}
            >
              prompt 제외
              <span className="block text-faint font-normal text-[10px] mt-0.5">
                &quot;prompt&quot;: null
              </span>
            </button>
          </div>
        </div>
      )}

      {/* 변환 버튼 + 진행률 바 */}
      {file && (
        <div className="space-y-3">
          <button
            onClick={handleConvert}
            disabled={!canConvert || mode === "loading"}
            className={`w-full py-3 rounded-xl text-sm font-semibold transition-colors ${
              !canConvert
                ? "bg-input text-faint cursor-not-allowed"
                : mode === "loading"
                ? "bg-cyan-700/50 text-cyan-400 cursor-wait"
                : "bg-cyan-600 hover:bg-cyan-500 text-white"
            }`}
          >
            {mode === "loading" ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                변환 중… (모델 로딩 포함, 잠시 기다려주세요)
              </span>
            ) : (
              "JSON으로 변환"
            )}
          </button>

          {/* 진행률 바 */}
          {mode === "loading" && (
            <div className="space-y-1.5">
              <div className="w-full bg-input rounded-full h-2 overflow-hidden">
                <div
                  className="h-2 rounded-full bg-cyan-500 transition-[width] duration-300 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-faint">
                <span>PE-Core 인코딩 중…</span>
                <span>{progress}%</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 에러 */}
      {mode === "error" && (
        <div className="bg-red-900/20 border border-red-800/60 rounded-xl px-4 py-3">
          <p className="text-xs text-red-400">{errorMsg}</p>
        </div>
      )}

      {/* 결과 */}
      {mode === "done" && resultBlobUrl && (
        <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-xl px-4 py-4 flex items-center justify-between gap-4">
          <p className="text-xs text-emerald-400">
            변환 완료 —{" "}
            <span className="font-semibold">{resultCount.toLocaleString()} 개</span> 항목
          </p>
          <button
            onClick={handleDownload}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors font-medium flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1M12 12v7m0 0l-3-3m3 3l3-3M12 5v7" />
            </svg>
            JSON 다운로드
          </button>
        </div>
      )}
    </div>
  );
}
