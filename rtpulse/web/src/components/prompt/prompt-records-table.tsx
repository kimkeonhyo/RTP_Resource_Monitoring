"use client";

import useSWR from "swr";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";

interface PromptRecord {
  id: number;
  project_name: string;
  version: string;
  assignees: string;
  applied_at: string | null;
  nas_path: string | null;   // JSON 파일 경로
  csv_path: string | null;   // CSV 파일 경로
  base_prompt: string | null;
  registered_at: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** F1 집계 응답 */
interface F1Stat { tp: number; fp: number; fn: number; total: number; f1: number | null }
interface F1Response {
  byVersion?: Record<string, F1Stat & { customers: number }>;
}

/** F1 점수 색상 (높을수록 초록) */
function f1Color(f1: number): string {
  if (f1 >= 0.8) return "text-emerald-400";
  if (f1 >= 0.5) return "text-amber-400";
  return "text-red-400";
}

/** F1-Score 표시 셀 */
function F1Cell({ stat }: { stat: (F1Stat & { customers?: number }) | undefined }) {
  if (!stat || stat.f1 === null) return <span className="text-faint text-xs">—</span>;
  const integrated = (stat.customers ?? 1) > 1;
  return (
    <div
      className="flex items-center gap-1.5"
      title={`정탐 ${stat.tp} · 오탐 ${stat.fp} · 미탐 ${stat.fn}${integrated ? ` · 고객사 ${stat.customers}곳 통합` : ""}`}
    >
      <span className={`font-mono text-xs font-semibold ${f1Color(stat.f1)}`}>{stat.f1.toFixed(3)}</span>
      {integrated && (
        <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800/50 whitespace-nowrap">
          통합 {stat.customers}
        </span>
      )}
    </div>
  );
}

const hasJson = (r: PromptRecord) => !!r.nas_path && r.nas_path.trim() !== "";
const hasCsv  = (r: PromptRecord) => !!r.csv_path && r.csv_path.trim() !== "";

/** 바이트를 MB/GB 등 읽기 쉬운 단위로 변환 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * XHR 기반 업로드 — fetch()와 달리 upload.onprogress 이벤트를 지원합니다.
 * onProgress(loaded, total) : 브라우저 → 서버 진행률
 */
function uploadWithProgress(
  url: string,
  body: FormData,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    });

    xhr.addEventListener("load", () => {
      let data: unknown;
      try { data = JSON.parse(xhr.responseText); } catch { data = { error: xhr.responseText.slice(0, 200) }; }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    });

    xhr.addEventListener("error",  () => reject(new Error("네트워크 오류가 발생했습니다.")));
    xhr.addEventListener("abort",  () => reject(new Error("업로드가 취소되었습니다.")));
    xhr.send(body);
  });
}

/** 업로드 진행 바 컴포넌트 */
function UploadProgressBar({
  phase,
  pct,
  loaded,
  total,
}: {
  phase: "uploading" | "saving";
  pct: number;
  loaded: number;
  total: number;
}) {
  return (
    <div className="space-y-2 py-1">
      {/* 바 */}
      <div className="h-2 bg-input rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-200 ease-out ${
            phase === "saving" ? "bg-amber-500 animate-pulse" : "bg-cyan-500"
          }`}
          style={{ width: phase === "saving" ? "100%" : `${pct}%` }}
        />
      </div>
      {/* 텍스트 */}
      <div className="flex items-center justify-between text-[11px]">
        {phase === "uploading" ? (
          <>
            <span className="text-muted">
              브라우저 → 서버&nbsp;&nbsp;
              <span className="text-cyan-400 font-mono">{formatBytes(loaded)}</span>
              <span className="text-faint"> / {formatBytes(total)}</span>
            </span>
            <span className="text-cyan-400 font-mono font-semibold">{pct}%</span>
          </>
        ) : (
          <>
            <span className="text-amber-400 flex items-center gap-1.5">
              <span className="animate-spin inline-block w-3 h-3 border-2 border-amber-400/30 border-t-amber-400 rounded-full" />
              NAS에 저장 중...
            </span>
            <span className="text-faint font-mono">100%</span>
          </>
        )}
      </div>
    </div>
  );
}

// ── 기존 레코드에 파일(JSON / CSV)을 업로드하는 미니 모달 ──────────────────

function FileUploadModal({
  record,
  onClose,
  onSuccess,
}: {
  record: PromptRecord;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile]     = useState<File | null>(null);
  const [error, setError]   = useState<string | null>(null);

  // 업로드 진행 상태
  const [phase, setPhase]   = useState<"idle" | "uploading" | "saving">("idle");
  const [pct, setPct]       = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal]   = useState(0);

  const loading  = phase !== "idle";
  const fileExt  = file?.name.toLowerCase().endsWith(".csv") ? "CSV" : file ? "JSON" : null;

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) { setError("파일을 선택하세요."); return; }
    setError(null);
    setPct(0); setLoaded(0); setTotal(0);
    setPhase("uploading");

    const fd = new FormData();
    fd.append("file", file);

    try {
      const { ok, data } = await uploadWithProgress(
        `/api/prompt-records/${record.id}/upload`,
        fd,
        (ld, tot) => {
          setLoaded(ld);
          setTotal(tot);
          setPct(Math.min(99, Math.round((ld / tot) * 100)));
          // 100%에 도달하면 NAS 저장 단계로 전환
          if (ld >= tot) setPhase("saving");
        },
      );

      if (!ok) {
        const errMsg = (data as { error?: string })?.error ?? "업로드 실패";
        setError(errMsg);
        setPhase("idle");
        return;
      }
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
      setPhase("idle");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-panel border border-line2 rounded-xl w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <div>
            <h2 className="text-sm font-semibold text-ink">파일 업로드</h2>
            <p className="text-xs text-faint mt-0.5">
              <span className="text-amber-400 font-mono">{record.project_name}</span>
              {" / "}
              <span className="text-cyan-400 font-mono">{record.version}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-faint hover:text-gray-300 transition-colors text-lg leading-none disabled:opacity-40"
          >
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1.5">
              JSON / CSV 파일 <span className="text-red-400">*</span>
            </label>
            <div
              className={`border border-dashed rounded-lg p-5 text-center transition-colors ${
                loading
                  ? "border-line cursor-not-allowed"
                  : "border-line2 cursor-pointer hover:border-amber-600"
              }`}
              onClick={() => !loading && fileRef.current?.click()}
            >
              {file ? (
                <div className="space-y-1">
                  <span className="text-sm text-amber-400 font-mono">{file.name}</span>
                  <p className="text-xs text-faint">{formatBytes(file.size)}</p>
                  {fileExt && (
                    <p className="text-xs text-faint">
                      {fileExt === "CSV" ? "CSV → csv_path 에 저장됩니다" : "JSON → nas_path 에 저장됩니다"}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  <span className="text-xs text-faint">클릭하여 파일 선택</span>
                  <p className="text-[10px] text-faint">.json 또는 .csv</p>
                </div>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.csv,application/json,text/csv"
              className="hidden"
              onChange={handleFile}
            />
          </div>

          {/* 업로드 진행 바 */}
          {loading && (
            <UploadProgressBar phase={phase === "saving" ? "saving" : "uploading"} pct={pct} loaded={loaded} total={total} />
          )}

          {error && (
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded px-3 py-2">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2 rounded-lg text-sm text-muted hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 rounded-lg text-sm bg-amber-700 hover:bg-amber-600 text-white font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? (
                phase === "saving" ? "NAS 저장 중..." : `업로드 중 ${pct}%`
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  NAS 업로드
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── 새 레코드 등록 + NAS 업로드 모달 ─────────────────────────────────────────

interface UploadForm {
  projectName: string;
  version: string;
  assignees: string;
  appliedAt: string;
  basePrompt: string;
  jsonFile: File | null;
  csvFile:  File | null;
}

function UploadModal({
  onClose,
  onSuccess,
  records,
}: {
  onClose: () => void;
  onSuccess: () => void;
  records: PromptRecord[];
}) {
  const jsonRef = useRef<HTMLInputElement>(null);
  const csvRef  = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<UploadForm>({
    projectName: "",
    version: "",
    assignees: "",
    appliedAt: "",
    basePrompt: "",
    jsonFile: null,
    csvFile:  null,
  });
  const [isNewProject, setIsNewProject] = useState(false);
  const [error, setError]  = useState<string | null>(null);

  // 업로드 진행 상태
  const [phase, setPhase]   = useState<"idle" | "uploading" | "saving">("idle");
  const [pct, setPct]       = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal]   = useState(0);

  const loading = phase !== "idle";

  const projectOptions = [...new Set(records.map((r) => r.project_name))].sort((a, b) =>
    a.localeCompare(b, "ko")
  );

  const set = (k: keyof UploadForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [k]: e.target.value }));

  const handleJsonFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setForm((prev) => ({ ...prev, jsonFile: f }));
    if (f) {
      f.text().then((text) => {
        try {
          // BOM 제거 후 파싱
          const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
          const json  = JSON.parse(clean);
          setForm((prev) => ({
            ...prev,
            jsonFile:    f,
            version:     json.version              ?? prev.version,
            projectName: json.project              ?? prev.projectName,
            basePrompt:  json.base_prompt          ?? prev.basePrompt,
            assignees:   json.metadata?.assignee   ?? prev.assignees,
            appliedAt:   json.metadata?.applied_at ?? prev.appliedAt,
          }));
        } catch { /* ignore — 자동완성 실패는 무시 */ }
      });
    }
  };

  const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setForm((prev) => ({ ...prev, csvFile: f }));
  };

  const handleProjectSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === "__new__") {
      setIsNewProject(true);
      setForm((prev) => ({ ...prev, projectName: "" }));
    } else {
      setForm((prev) => ({ ...prev, projectName: e.target.value }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.jsonFile)           { setError("JSON 파일을 선택하세요."); return; }
    if (!form.projectName.trim()) { setError("프로젝트명을 입력하세요."); return; }
    if (!form.version.trim())     { setError("버전명을 입력하세요."); return; }

    setError(null);
    setPct(0); setLoaded(0); setTotal(0);
    setPhase("uploading");

    const fd = new FormData();
    fd.append("jsonFile",    form.jsonFile);
    if (form.csvFile) fd.append("csvFile", form.csvFile);
    fd.append("projectName", form.projectName.trim());
    fd.append("version",     form.version.trim());
    fd.append("assignees",   form.assignees);
    fd.append("appliedAt",   form.appliedAt);
    fd.append("basePrompt",  form.basePrompt);

    try {
      const { ok, data } = await uploadWithProgress(
        "/api/prompt-records/upload",
        fd,
        (ld, tot) => {
          setLoaded(ld);
          setTotal(tot);
          setPct(Math.min(99, Math.round((ld / tot) * 100)));
          if (ld >= tot) setPhase("saving");
        },
      );

      if (!ok) {
        const errMsg = (data as { error?: string })?.error ?? "업로드 실패";
        setError(errMsg);
        setPhase("idle");
        return;
      }
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
      setPhase("idle");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-panel border border-line2 rounded-xl w-full max-w-lg mx-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line sticky top-0 bg-panel z-10">
          <h2 className="text-sm font-semibold text-ink">프롬프트 등록 (NAS 업로드)</h2>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-faint hover:text-gray-300 transition-colors text-lg leading-none disabled:opacity-40"
          >
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">

          {/* JSON 파일 (필수) */}
          <div>
            <label className="block text-xs text-muted mb-1.5">
              JSON 파일 <span className="text-red-400">*</span>
            </label>
            <div
              className={`border border-dashed rounded-lg p-4 text-center transition-colors ${
                loading
                  ? "border-line cursor-not-allowed"
                  : "border-line2 cursor-pointer hover:border-cyan-700"
              }`}
              onClick={() => !loading && jsonRef.current?.click()}
            >
              {form.jsonFile ? (
                <div className="space-y-0.5">
                  <span className="text-sm text-cyan-400 font-mono">{form.jsonFile.name}</span>
                  <p className="text-xs text-faint">{formatBytes(form.jsonFile.size)}</p>
                </div>
              ) : (
                <span className="text-xs text-faint">클릭하여 JSON 파일 선택</span>
              )}
            </div>
            <input ref={jsonRef} type="file" accept=".json,application/json" className="hidden" onChange={handleJsonFile} />
          </div>

          {/* CSV 파일 (선택) */}
          <div>
            <label className="block text-xs text-muted mb-1.5">
              CSV 파일 <span className="text-faint font-normal">(선택)</span>
            </label>
            <div
              className={`border border-dashed rounded-lg p-4 text-center transition-colors ${
                loading
                  ? "border-line cursor-not-allowed"
                  : "border-line2 cursor-pointer hover:border-green-700"
              }`}
              onClick={() => !loading && csvRef.current?.click()}
            >
              {form.csvFile ? (
                <div className="space-y-0.5">
                  <span className="text-sm text-green-400 font-mono">{form.csvFile.name}</span>
                  <p className="text-xs text-faint">{formatBytes(form.csvFile.size)}</p>
                </div>
              ) : (
                <span className="text-xs text-faint">클릭하여 CSV 파일 선택 (선택사항)</span>
              )}
            </div>
            <input ref={csvRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleCsvFile} />
          </div>

          {/* 프로젝트명 */}
          <div>
            <label className="block text-xs text-muted mb-1.5">프로젝트명 <span className="text-red-400">*</span></label>
            {isNewProject ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  autoFocus
                  placeholder="신규 프로젝트명 입력"
                  value={form.projectName}
                  onChange={set("projectName")}
                  disabled={loading}
                  className="flex-1 bg-input border border-cyan-700/60 rounded-lg px-3 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => { setIsNewProject(false); setForm((prev) => ({ ...prev, projectName: "" })); }}
                  className="px-3 py-2 rounded-lg text-xs text-faint hover:text-gray-300 border border-line2 hover:border-gray-600 transition-colors whitespace-nowrap disabled:opacity-50"
                >
                  ← 목록
                </button>
              </div>
            ) : (
              <select
                value={form.projectName}
                onChange={handleProjectSelect}
                disabled={loading}
                className="w-full bg-input border border-line2 rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-cyan-600 disabled:opacity-50"
              >
                <option value="">선택하세요</option>
                {projectOptions.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
                <option disabled>──────────</option>
                <option value="__new__">+ 신규 프로젝트 추가</option>
              </select>
            )}
          </div>

          {/* 버전명 */}
          <div>
            <label className="block text-xs text-muted mb-1.5">버전명 <span className="text-red-400">*</span></label>
            <input
              type="text"
              placeholder="v1.0.0.5"
              value={form.version}
              onChange={set("version")}
              disabled={loading}
              className="w-full bg-input border border-line2 rounded-lg px-3 py-2 text-sm text-ink font-mono placeholder:text-faint focus:outline-none focus:border-cyan-600 disabled:opacity-50"
            />
          </div>

          {/* 담당자 */}
          <div>
            <label className="block text-xs text-muted mb-1.5">담당자</label>
            <input
              type="text"
              placeholder="홍길동, 김철수"
              value={form.assignees}
              onChange={set("assignees")}
              disabled={loading}
              className="w-full bg-input border border-line2 rounded-lg px-3 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:border-cyan-600 disabled:opacity-50"
            />
          </div>

          {/* VMS 적용 일자 */}
          <div>
            <label className="block text-xs text-muted mb-1.5">VMS 적용 일자</label>
            <input
              type="date"
              value={form.appliedAt}
              onChange={set("appliedAt")}
              disabled={loading}
              className="w-full bg-input border border-line2 rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-cyan-600 disabled:opacity-50"
            />
          </div>

          {/* Base Prompt */}
          <div>
            <label className="block text-xs text-muted mb-1.5">Base Prompt</label>
            <select
              value={form.basePrompt}
              onChange={set("basePrompt")}
              disabled={loading}
              className="w-full bg-input border border-line2 rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-cyan-600 disabled:opacity-50"
            >
              <option value="">없음</option>
              {records.map((r) => (
                <option key={r.id} value={r.version}>
                  {r.version} — {r.project_name}
                </option>
              ))}
            </select>
          </div>

          {/* 업로드 진행 바 */}
          {loading && (
            <UploadProgressBar phase={phase === "saving" ? "saving" : "uploading"} pct={pct} loaded={loaded} total={total} />
          )}

          {error && (
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded px-3 py-2">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2 rounded-lg text-sm text-muted hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 rounded-lg text-sm bg-cyan-700 hover:bg-cyan-600 text-white font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading
                ? phase === "saving"
                  ? "NAS 저장 중..."
                  : `업로드 중 ${pct}%`
                : "NAS 업로드 & 등록"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Base Prompt 미리보기 모달 ─────────────────────────────────────────────────

function PromptPreviewModal({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-panel border border-line2 rounded-xl w-full max-w-2xl mx-4 shadow-2xl max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 className="text-sm font-semibold text-ink">Base Prompt</h2>
          <button onClick={onClose} className="text-faint hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>
        <pre className="px-6 py-4 text-xs text-ink2 overflow-y-auto whitespace-pre-wrap leading-relaxed">{text}</pre>
      </div>
    </div>
  );
}

// ── Notion 동기화 모달 (옵션 선택 + 진행률) ──────────────────────────────────

interface SyncProgress { index: number; total: number; version: string }
interface SyncCounts { inserted: number; updated: number; uploaded: number; skipped: number }
interface SyncResult { version: string; action: "done" | "failed" | "skip"; detail?: string; reason?: string }

function SyncModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [wantCsv, setWantCsv]   = useState(true);
  const [wantJson, setWantJson] = useState(true);
  const [force, setForce]       = useState(false);
  const [phase, setPhase]       = useState<"config" | "running" | "done" | "error">("config");
  const [prog, setProg]         = useState<SyncProgress>({ index: 0, total: 0, version: "" });
  const [counts, setCounts]     = useState<SyncCounts>({ inserted: 0, updated: 0, uploaded: 0, skipped: 0 });
  const [results, setResults]   = useState<SyncResult[]>([]);
  const [err, setErr]           = useState("");

  const pollRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef  = useRef(true);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 서버 작업 상태(job)를 UI에 반영. 종료됐으면 true 반환.
  const applyJob = useCallback((job: {
    running: boolean; total?: number; index?: number; version?: string;
    counts?: SyncCounts; results?: SyncResult[]; error?: string | null;
  }): boolean => {
    setProg({ index: job.index ?? 0, total: job.total ?? 0, version: job.version ?? "" });
    setCounts(job.counts ?? { inserted: 0, updated: 0, uploaded: 0, skipped: 0 });
    setResults(job.results ?? []);
    if (!job.running) {
      if (job.error) { setErr(job.error); setPhase("error"); }
      else setPhase("done");
      onDoneRef.current();
      return true;
    }
    return false;
  }, []);

  const poll = useCallback(async () => {
    if (!aliveRef.current) return;
    try {
      const res = await fetch("/api/prompt-records/sync-status", { cache: "no-store" });
      const job = await res.json();
      const stopped = applyJob(job);
      if (!stopped && aliveRef.current) pollRef.current = setTimeout(poll, 1500);
    } catch {
      if (aliveRef.current) pollRef.current = setTimeout(poll, 2500); // 일시 실패는 재시도
    }
  }, [applyJob]);

  const start = useCallback(async () => {
    setPhase("running");
    setResults([]);
    setProg({ index: 0, total: 0, version: "" });
    setErr("");
    try {
      // 백그라운드 작업 시작 (202) 또는 이미 실행 중(409) — 둘 다 폴링으로 이어봄
      const res = await fetch(`/api/prompt-records?csv=${wantCsv ? 1 : 0}&json=${wantJson ? 1 : 0}&force=${force ? 1 : 0}`, { method: "POST" });
      if (!res.ok && res.status !== 409) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `동기화 요청 실패 (HTTP ${res.status})`);
      }
      poll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [wantCsv, wantJson, force, poll]);

  // 모달을 열 때 이미 실행 중인 동기화가 있으면 진행 상황을 이어서 표시(폴링).
  useEffect(() => {
    aliveRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/prompt-records/sync-status", { cache: "no-store" });
        const job = await res.json();
        if (job.running) {
          setWantCsv(job.options?.csv ?? true);
          setWantJson(job.options?.json ?? true);
          setPhase("running");
          poll();
        }
      } catch { /* 무시 */ }
    })();
    return () => { aliveRef.current = false; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [poll]);

  const pct = prog.total > 0 ? Math.round((prog.index / prog.total) * 100) : 0;
  const closable = true; // 백그라운드 작업이라 언제든 닫아도 계속 진행됨

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => closable && onClose()}>
      <div className="bg-panel border border-line2 rounded-xl w-full max-w-lg mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 className="text-sm font-semibold text-ink">Notion 동기화</h2>
          {closable && <button onClick={onClose} className="text-faint hover:text-gray-300 text-lg leading-none">&times;</button>}
        </div>

        <div className="px-6 py-5 space-y-4">
          {phase === "config" && (
            <>
              <p className="text-xs text-faint">Notion 프롬프트 DB를 동기화합니다. NAS에 저장할 항목을 선택하세요.</p>
              <label className="flex items-center gap-3 text-sm text-ink cursor-pointer">
                <input type="checkbox" checked={wantCsv} onChange={(e) => setWantCsv(e.target.checked)} className="w-4 h-4 accent-purple-600" />
                <span>CSV 원본 NAS 저장 <span className="text-faint">(HuggingFace CSV → NAS)</span></span>
              </label>
              <label className="flex items-center gap-3 text-sm text-ink cursor-pointer">
                <input type="checkbox" checked={wantJson} onChange={(e) => setWantJson(e.target.checked)} className="w-4 h-4 accent-purple-600" />
                <span>JSON 변환·업로드 <span className="text-faint">(Flask 피처추출 → NAS)</span></span>
              </label>
              <label className="flex items-center gap-3 text-sm text-ink cursor-pointer border-t border-line2/40 pt-3 mt-1">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="w-4 h-4 accent-amber-600" />
                <span>이미 업로드된 항목도 재업로드 <span className="text-faint">(NAS 유실 복구 · 건너뜀 대신 다시 올림)</span></span>
              </label>
              {!wantCsv && !wantJson && <p className="text-xs text-amber-500">최소 1개는 선택해야 합니다.</p>}
            </>
          )}

          {(phase === "running" || phase === "done") && (
            <>
              <div className="flex items-center justify-between text-xs text-faint">
                <span>{phase === "done" ? "완료" : `처리 중… ${prog.index}/${prog.total}`}</span>
                <span>{pct}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-input overflow-hidden">
                <div className={`h-full ${phase === "done" ? "bg-emerald-500" : "bg-purple-600"} transition-all duration-200`} style={{ width: `${pct}%` }} />
              </div>
              {phase === "running" && prog.version && <p className="text-xs text-ink2 truncate">현재: {prog.version}</p>}
              <div className="flex gap-3 text-xs text-faint">
                <span>신규 {counts.inserted}</span><span>업뎃 {counts.updated}</span>
                <span className="text-emerald-500">업로드 {counts.uploaded}</span><span>건너뜀 {counts.skipped}</span>
              </div>
              {results.length > 0 && (
                <div className="max-h-56 overflow-y-auto rounded border border-line bg-input/30 divide-y divide-line/60">
                  {[...results].reverse().map((r, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px]">
                      <span className="text-ink2 truncate">{r.version}</span>
                      {r.action === "done" && <span className="shrink-0 text-emerald-500">저장 {r.detail}</span>}
                      {r.action === "failed" && <span className="shrink-0 text-red-400 truncate max-w-[55%]" title={r.reason}>실패 — {r.reason}</span>}
                      {r.action === "skip" && <span className="shrink-0 text-faint">건너뜀</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {phase === "error" && <p className="text-sm text-red-400 whitespace-pre-wrap">오류: {err}</p>}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-line">
          {phase === "config" && (
            <>
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-faint hover:text-ink">취소</button>
              <button onClick={start} disabled={!wantCsv && !wantJson}
                className="px-4 py-2 rounded-lg text-sm bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white font-medium">
                동기화 시작
              </button>
            </>
          )}
          {phase === "running" && (
            <>
              <span className="px-2 py-2 text-sm text-faint animate-pulse mr-auto">동기화 중… (백그라운드로 계속됨)</span>
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-faint hover:text-ink">닫기</button>
            </>
          )}
          {(phase === "done" || phase === "error") && (
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-purple-700 hover:bg-purple-600 text-white font-medium">확인</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 자동 동기화 설정 모달 (시간 목록 + CSV/JSON 옵션) ────────────────────────

interface SyncSchedule { enabled: boolean; times: string[]; csv: boolean; json: boolean }

function SyncScheduleModal({ onClose }: { onClose: () => void }) {
  const [sch, setSch]       = useState<SyncSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState("");

  useEffect(() => {
    fetch("/api/prompt-records/schedule", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: SyncSchedule) => setSch({
        enabled: !!d.enabled,
        times: Array.isArray(d.times) && d.times.length ? d.times : ["08:00"],
        csv: d.csv !== false,
        json: d.json !== false,
      }))
      .catch(() => setSch({ enabled: false, times: ["08:00"], csv: true, json: true }));
  }, []);

  const save = async () => {
    if (!sch) return;
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/prompt-records/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sch),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "저장 실패");
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const setTime = (i: number, v: string) => setSch((s) => s && ({ ...s, times: s.times.map((t, j) => (j === i ? v : t)) }));
  const addTime = () => setSch((s) => s && ({ ...s, times: [...s.times, "12:00"] }));
  const removeTime = (i: number) => setSch((s) => s && ({ ...s, times: s.times.filter((_, j) => j !== i) }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-panel border border-line2 rounded-xl w-full max-w-md mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 className="text-sm font-semibold text-ink">자동 동기화 설정</h2>
          <button onClick={onClose} className="text-faint hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>

        {!sch ? (
          <div className="px-6 py-8 text-xs text-faint animate-pulse">불러오는 중…</div>
        ) : (
          <div className="px-6 py-5 space-y-4">
            <label className="flex items-center gap-3 text-sm text-ink cursor-pointer">
              <input type="checkbox" checked={sch.enabled} onChange={(e) => setSch({ ...sch, enabled: e.target.checked })} className="w-4 h-4 accent-purple-600" />
              <span>자동 동기화 사용 <span className="text-faint">(설정한 시각에 매일, KST)</span></span>
            </label>

            <div className={sch.enabled ? "" : "opacity-40 pointer-events-none"}>
              <p className="text-xs text-faint mb-1.5">실행 시각 (매일)</p>
              <div className="space-y-2">
                {sch.times.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input type="time" value={t} onChange={(e) => setTime(i, e.target.value)}
                      className="bg-input border border-line rounded px-2 py-1 text-sm text-ink" />
                    <button onClick={() => removeTime(i)} className="text-faint hover:text-red-400 text-sm px-1" title="삭제">✕</button>
                  </div>
                ))}
                <button onClick={addTime} className="text-xs text-cyan-400 hover:text-cyan-300">+ 시간 추가</button>
                {sch.times.length === 0 && <p className="text-xs text-amber-500">시간을 1개 이상 추가하세요.</p>}
              </div>

              <p className="text-xs text-faint mt-4 mb-1.5">저장 대상</p>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
                  <input type="checkbox" checked={sch.csv} onChange={(e) => setSch({ ...sch, csv: e.target.checked })} className="w-4 h-4 accent-purple-600" />
                  CSV
                </label>
                <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
                  <input type="checkbox" checked={sch.json} onChange={(e) => setSch({ ...sch, json: e.target.checked })} className="w-4 h-4 accent-purple-600" />
                  JSON
                </label>
              </div>
            </div>

            {err && <p className="text-xs text-red-400">{err}</p>}
          </div>
        )}

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-line">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-faint hover:text-ink">취소</button>
          <button onClick={save} disabled={saving || !sch || (sch.enabled && (sch.times.length === 0 || (!sch.csv && !sch.json)))}
            className="px-4 py-2 rounded-lg text-sm bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white font-medium">
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 파일 셀 공통 컴포넌트 ────────────────────────────────────────────────────

function FileCell({
  filePath,
  label,
  accentColor,
  onUpload,
  onDownload,
  onDeleteFile,
  downloading,
  deletingFile,
}: {
  filePath: string | null;
  label: string;
  accentColor: "amber" | "green";
  onUpload: () => void;
  onDownload: () => void;
  onDeleteFile: () => void;
  downloading: boolean;
  deletingFile: boolean;
}) {
  const hasFile = !!filePath && filePath.trim() !== "";
  const colorMap = {
    amber: {
      btn: "bg-amber-100 border-amber-400 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:border-amber-700/50 dark:text-amber-400 dark:hover:bg-amber-900/50 dark:hover:text-amber-300",
      text: "hover:text-amber-300",
    },
    green: {
      btn: "bg-green-900/30 border-green-700/50 text-green-400 hover:bg-green-900/50 hover:text-green-300",
      text: "hover:text-green-300",
    },
  }[accentColor];

  if (hasFile) {
    if (downloading || deletingFile) {
      return <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-gray-600 border-t-cyan-400 rounded-full" />;
    }
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={`font-mono text-xs text-faint truncate cursor-pointer ${colorMap.text} transition-colors`}
          title={filePath!}
          onClick={onDownload}
        >
          {filePath!.split("/").pop()}
        </span>
        <button
          onClick={onDeleteFile}
          title="파일 삭제 (NAS 포함)"
          className="flex-shrink-0 p-0.5 text-faint hover:text-red-400 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onUpload}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border ${colorMap.btn} transition-colors`}
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
      </svg>
      {label}
    </button>
  );
}

// ── 메인 테이블 ───────────────────────────────────────────────────────────────

export default function PromptRecordsTable() {
  const { data: records, isLoading, mutate } = useSWR<PromptRecord[]>("/api/prompt-records", fetcher);
  const { data: activeMap } = useSWR<Record<string, string[]>>("/api/prompt-history/active", fetcher);
  const { data: f1Data } = useSWR<F1Response>("/api/prompt-history/f1", fetcher);
  const [showUpload, setShowUpload]           = useState(false);
  const [fileUploadRecord, setFileUploadRecord] = useState<PromptRecord | null>(null);
  const [previewText, setPreviewText]         = useState<string | null>(null);
  const [downloading, setDownloading]         = useState<{ id: number; type: "json" | "csv" } | null>(null);
  const [deleting, setDeleting]               = useState<number | null>(null);
  const [deletingFile, setDeletingFile]       = useState<{ id: number; type: "json" | "csv" } | null>(null);
  const [showSync, setShowSync]               = useState(false);
  const [showSchedule, setShowSchedule]       = useState(false);
  const [search, setSearch]                   = useState("");
  const [projectFilter, setProjectFilter]     = useState("");   // "" = 전체
  const [onlyMissingJson, setOnlyMissingJson] = useState(false);
  const missingJsonCount = records ? records.filter((r) => !hasJson(r)).length : 0;

  // 프로젝트 필터 옵션 (등록된 프로젝트명 distinct)
  const projectNames = useMemo(
    () => [...new Set((records ?? []).map((r) => r.project_name).filter(Boolean))].sort(),
    [records],
  );

  // 검색(프로젝트/버전/담당자/Base Prompt) + 프로젝트 필터 + JSON 미업로드 필터
  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (records ?? []).filter((r) => {
      if (projectFilter && r.project_name !== projectFilter) return false;
      if (onlyMissingJson && hasJson(r)) return false;
      if (!q) return true;
      return [r.project_name, r.version, r.assignees, r.base_prompt]
        .some((v) => (v ?? "").toLowerCase().includes(q));
    });
  }, [records, search, projectFilter, onlyMissingJson]);

  const handleDownload = useCallback((record: PromptRecord, type: "json" | "csv") => {
    const filePath = type === "json" ? record.nas_path : record.csv_path;
    if (!filePath) return;

    setDownloading({ id: record.id, type });
    const a = document.createElement("a");
    a.href  = `/api/prompt-records/download?path=${encodeURIComponent(filePath)}`;
    a.download = `${record.project_name}_${record.version}.${type}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => setDownloading(null), 3_000);
  }, []);

  const handleDeleteFile = useCallback(async (record: PromptRecord, type: "json" | "csv") => {
    const label = type === "json" ? "JSON" : "CSV";
    if (!confirm(`"${record.project_name} ${record.version}"의 ${label} 파일을 삭제하시겠습니까?\n(NAS 실제 파일도 함께 삭제됩니다)`)) return;
    setDeletingFile({ id: record.id, type });
    try {
      const field = type === "json" ? "nas_path" : "csv_path";
      await fetch(`/api/prompt-records/${record.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field }),
      });
      mutate();
    } finally {
      setDeletingFile(null);
    }
  }, [mutate]);

  const handleDelete = useCallback(async (record: PromptRecord) => {
    if (!confirm(`"${record.project_name} ${record.version}"을(를) 삭제하시겠습니까?\n(NAS 파일은 삭제되지 않습니다)`)) return;
    setDeleting(record.id);
    try {
      await fetch(`/api/prompt-records/${record.id}`, { method: "DELETE" });
      mutate();
    } finally {
      setDeleting(null);
    }
  }, [mutate]);

  return (
    <>
      {showUpload && (
        <UploadModal onClose={() => setShowUpload(false)} onSuccess={() => mutate()} records={records ?? []} />
      )}
      {showSync && (
        <SyncModal onClose={() => setShowSync(false)} onDone={() => mutate()} />
      )}
      {showSchedule && (
        <SyncScheduleModal onClose={() => setShowSchedule(false)} />
      )}
      {fileUploadRecord && (
        <FileUploadModal
          record={fileUploadRecord}
          onClose={() => setFileUploadRecord(null)}
          onSuccess={() => mutate()}
        />
      )}
      {previewText !== null && (
        <PromptPreviewModal text={previewText} onClose={() => setPreviewText(null)} />
      )}

      {/* 툴바 */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-faint flex items-center gap-3">
          {records ? (filteredRecords.length === records.length ? `총 ${records.length}건` : `${filteredRecords.length} / ${records.length}건`) : ""}
          {missingJsonCount > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-100 border border-amber-300 rounded px-2 py-0.5 dark:text-amber-500 dark:bg-amber-900/20 dark:border-amber-800/40">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              JSON 미업로드 {missingJsonCount}건
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSchedule(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-line text-faint hover:text-ink hover:border-line2 transition-colors"
            title="자동 동기화 설정"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            자동 동기화
          </button>
          <button
            onClick={() => setShowSync(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Notion 동기화
          </button>
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-cyan-700 hover:bg-cyan-600 text-white font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            NAS 업로드 &amp; 등록
          </button>
        </div>
      </div>

      {/* 검색 · 필터 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative">
          <svg className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="프로젝트·버전·담당자·프롬프트 검색"
            className="bg-input border border-line rounded-lg pl-8 pr-3 py-1.5 text-sm text-ink w-72"
          />
        </div>
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="bg-input border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink"
        >
          <option value="">전체 프로젝트</option>
          {projectNames.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-faint cursor-pointer select-none px-1">
          <input type="checkbox" checked={onlyMissingJson} onChange={(e) => setOnlyMissingJson(e.target.checked)} className="w-3.5 h-3.5 accent-amber-500" />
          JSON 미업로드만
        </label>
        {(search || projectFilter || onlyMissingJson) && (
          <button onClick={() => { setSearch(""); setProjectFilter(""); setOnlyMissingJson(false); }}
            className="text-xs text-faint hover:text-ink px-2">초기화</button>
        )}
      </div>

      {/* 테이블 */}
      <div className="border border-line rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-input/70 text-xs text-muted uppercase tracking-wider">
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">프로젝트명</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">버전명</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">사용 중</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">F1-Score</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">담당자</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">VMS 적용일자</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">JSON 파일</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Base Prompt</th>
                <th className="px-4 py-3 text-center font-medium w-20 whitespace-nowrap">작업</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {isLoading && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-faint text-xs">
                    <span className="animate-pulse">불러오는 중...</span>
                  </td>
                </tr>
              )}
              {!isLoading && (!records || records.length === 0) && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-faint text-xs">
                    등록된 프롬프트가 없습니다.<br />
                    <span className="text-faint">위의 [NAS 업로드 &amp; 등록] 버튼으로 첫 번째 프롬프트를 추가하세요.</span>
                  </td>
                </tr>
              )}
              {!isLoading && records && records.length > 0 && filteredRecords.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-faint text-xs">검색/필터 결과가 없습니다.</td>
                </tr>
              )}
              {filteredRecords.map((r) => (
                <tr key={r.id} className="hover:bg-input/30 transition-colors">
                  {/* 프로젝트명 */}
                  <td className="px-4 py-3">
                    <span className="text-ink font-medium">{r.project_name}</span>
                  </td>
                  {/* 버전명 */}
                  <td className="px-4 py-3">
                    <span className="font-mono text-cyan-700 text-xs bg-cyan-100 border border-cyan-300 px-2 py-0.5 rounded dark:text-cyan-400 dark:bg-cyan-900/20 dark:border-cyan-900/40">
                      {r.version}
                    </span>
                  </td>
                  {/* 사용 중 */}
                  <td className="px-4 py-3">
                    {(() => {
                      const customers = activeMap?.[r.version.toLowerCase()] ?? [];
                      if (customers.length === 0) return <span className="text-faint text-xs">—</span>;
                      return (
                        <div className="flex flex-wrap gap-1">
                          {customers.map((name) => (
                            <span key={name} className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-900/30 text-emerald-400 border border-emerald-800/50 whitespace-nowrap">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                              {name}
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                  </td>
                  {/* F1-Score (다중 고객사 사용 시 통합) */}
                  <td className="px-4 py-3">
                    <F1Cell stat={f1Data?.byVersion?.[r.version.toLowerCase()]} />
                  </td>
                  {/* 담당자 */}
                  <td className="px-4 py-3 text-muted text-xs">{r.assignees || "—"}</td>
                  {/* VMS 적용일자 */}
                  <td className="px-4 py-3 text-muted text-xs font-mono whitespace-nowrap">
                    {r.applied_at ? r.applied_at.slice(0, 10) : "—"}
                  </td>
                  {/* JSON 파일 */}
                  <td className="px-4 py-3 max-w-[160px]">
                    <FileCell
                      filePath={r.nas_path}
                      label="JSON 업로드"
                      accentColor="amber"
                      onUpload={() => setFileUploadRecord(r)}
                      onDownload={() => handleDownload(r, "json")}
                      onDeleteFile={() => handleDeleteFile(r, "json")}
                      downloading={downloading?.id === r.id && downloading?.type === "json"}
                      deletingFile={deletingFile?.id === r.id && deletingFile?.type === "json"}
                    />
                  </td>

                  {/* Base Prompt */}
                  <td className="px-4 py-3 max-w-[200px]">
                    {r.base_prompt ? (
                      <button
                        onClick={() => setPreviewText(r.base_prompt!)}
                        className="text-xs text-left text-faint hover:text-gray-300 transition-colors line-clamp-2 leading-relaxed"
                      >
                        {r.base_prompt}
                      </button>
                    ) : (
                      <span className="text-faint text-xs">—</span>
                    )}
                  </td>
                  {/* 작업 */}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => handleDelete(r)}
                        disabled={deleting === r.id}
                        title="삭제"
                        className="p-1.5 text-faint hover:text-red-400 transition-colors disabled:opacity-30"
                      >
                        {deleting === r.id ? (
                          <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-gray-600 border-t-red-400 rounded-full" />
                        ) : (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
