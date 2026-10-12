"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Customer } from "@/lib/types";
import Image from "next/image";
import AutoLabelControls from "@/components/auto-label-controls";

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

type DetectionResult = "TP" | "FP" | "TN" | "FN" | null;

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

// ─── 부모: 탭 + subPath 공유 ───────────────────────────────────────────────────

export default function OnpremDataList({ customer }: { customer: Customer }) {
  const [tab,     setTab]     = useState<"extract" | "upload" | "list" | "registered">("list");
  // NAS 서브경로: 고객사명으로 고정 (편집 불가)
  const subPath    = customer.name;
  const setSubPath = (_: string) => { /* 고정값 — 변경 불가 */ };

  return (
    <div className="border border-line rounded-xl overflow-hidden">
      <div className="flex border-b border-line bg-panel/50 flex-wrap">
        <SubTab active={tab === "extract"}    onClick={() => setTab("extract")}    label="Data Extract"  icon="⬇" />
        <SubTab active={tab === "upload"}     onClick={() => setTab("upload")}     label="NAS 업로드"     icon="⬆" />
        <SubTab active={tab === "list"}       onClick={() => setTab("list")}       label="업로드 완료"    icon="☑" />
        <SubTab active={tab === "registered"} onClick={() => setTab("registered")} label="등록된 이벤트"  icon="★" />
      </div>
      <div className="p-4">
        {tab === "extract" && <DataExtract customer={customer} />}
        {tab === "upload"  && (
          <NasUpload
            customer={customer}
            subPath={subPath}
            setSubPath={setSubPath}
            onUploaded={() => setTab("list")}
          />
        )}
        {tab === "list" && (
          <NasList
            customer={customer}
            subPath={subPath}
            setSubPath={setSubPath}
            onRegistered={() => setTab("registered")}
          />
        )}
        {tab === "registered" && (
          <RegisteredEventsList customer={customer} />
        )}
      </div>
    </div>
  );
}

// ─── Data Extract ─────────────────────────────────────────────────────────────

function DataExtract({ customer }: { customer: Customer }) {
  const [from, setFrom] = useState("");
  const [to,   setTo]   = useState("");

  useEffect(() => {
    setFrom(weekAgoKST());
    setTo(todayKST());
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        VIP(<code className="text-amber-400">{customer.vip ?? "미설정"}</code>)의 MinIO에서
        데이터를 추출하는 shell 스크립트를 다운로드합니다.
      </p>
      <div className="grid grid-cols-2 gap-3 max-w-sm">
        <div>
          <label className="block text-xs text-faint mb-1">시작일 (KST)</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="w-full px-3 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-amber-600" />
        </div>
        <div>
          <label className="block text-xs text-faint mb-1">종료일 (KST)</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="w-full px-3 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-amber-600" />
        </div>
      </div>
      <button
        onClick={() => window.open(`/api/nas/${customer.id}/extract-script?from=${from}&to=${to}`, "_blank")}
        disabled={!customer.vip}
        className="flex items-center gap-2 px-4 py-2 bg-amber-800/60 text-amber-300 border border-amber-700 rounded-lg text-sm hover:bg-amber-800 disabled:opacity-40"
      >
        <span>⬇</span> Data Extract 스크립트 다운로드
      </button>
      <div className="bg-panel border border-line rounded-lg p-3 text-xs text-faint font-mono space-y-1">
        <p className="text-muted font-semibold mb-2"># 스크립트 실행 방법</p>
        <p>chmod +x extract_*.sh && ./extract_*.sh</p>
        <p className="text-faint mt-2"># MinIO client(mc) 없을 경우:</p>
        <p>curl https://dl.min.io/client/mc/release/linux-amd64/mc \</p>
        <p>{"  "}-o /usr/local/bin/mc && chmod +x /usr/local/bin/mc</p>
      </div>
    </div>
  );
}

// ─── NAS Upload ───────────────────────────────────────────────────────────────

function NasUpload({
  customer, subPath, setSubPath, onUploaded,
}: {
  customer: Customer;
  subPath: string;
  setSubPath: (v: string) => void;
  onUploaded: () => void;
}) {
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading,     setUploading]     = useState(false);
  const [result,        setResult]        = useState<{ ok: boolean; msg: string } | null>(null);

  // webkitdirectory는 React JSX에서 DOM 속성으로 전달이 불안정하므로
  // 마운트 후 useEffect에서 직접 setAttribute로 주입
  useEffect(() => {
    const el = folderInputRef.current;
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("multiple", "");
    }
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    // 숨김파일(.DS_Store 등) 제거
    const files = Array.from(e.target.files ?? []).filter(
      (f) => !f.name.startsWith(".")
    );
    setSelectedFiles(files);
    setResult(null);
  }

  // basename 기준으로 분류 (webkitdirectory 시 f.name에 경로 포함될 수 있음)
  const baseName = (f: File) => f.name.includes("/") ? (f.name.split("/").pop() ?? f.name) : f.name;

  /**
   * 파일명 형식 검증: {카메라ID}_{이벤트명}_{YYYYMMDD}_{HHMMSS}.{ext}
   * 서버의 parseBaseName 정규식과 동일하게 적용
   * - 확장자 제외 부분이 `.+_\d{8}_\d{6}` 패턴이어야 함
   * - 날짜/시간 범위도 기본 검증 (월 01-12, 일 01-31, 시 00-23, 분/초 00-59)
   */
  function isValidFileName(f: File): boolean {
    const name = baseName(f);
    const m = name.match(/^(.+)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.(mp4|mov|avi|mkv|jpg|jpeg|png|webp)$/i);
    if (!m) return false;
    const [, stem, , mm, dd, hh, mi, ss] = m;
    // stem에 _ 가 있어야 cameraId_eventName 분리 가능
    if (!stem.includes("_")) return false;
    // 날짜·시간 범위 기본 검증
    if (Number(mm) < 1 || Number(mm) > 12) return false;
    if (Number(dd) < 1 || Number(dd) > 31) return false;
    if (Number(hh) > 23) return false;
    if (Number(mi) > 59) return false;
    if (Number(ss) > 59) return false;
    return true;
  }

  const videoFiles = selectedFiles.filter((f) => /\.(mp4|mov|avi|mkv)$/i.test(baseName(f)));
  const thumbFiles = selectedFiles.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(baseName(f)));
  const otherFiles = selectedFiles.filter(
    (f) => !/\.(mp4|mov|avi|mkv|jpg|jpeg|png|webp)$/i.test(baseName(f))
  );
  // 지원 확장자이지만 파일명 형식이 맞지 않는 파일
  const invalidFmtFiles = selectedFiles.filter(
    (f) => /\.(mp4|mov|avi|mkv|jpg|jpeg|png|webp)$/i.test(baseName(f)) && !isValidFileName(f)
  );
  // 업로드 가능한 파일 (확장자 O + 형식 O)
  const uploadableFiles = selectedFiles.filter(
    (f) => /\.(mp4|mov|avi|mkv|jpg|jpeg|png|webp)$/i.test(baseName(f)) && isValidFileName(f)
  );

  /** File/Blob → base64 문자열 (FileReader 사용) */
  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve((reader.result as string).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * 영상 파일 청크 업로드 (5MB 단위)
   * Next.js route handler body limit ≈ 10MB 우회:
   *   5MB raw → 6.7MB base64 + JSON overhead → 10MB 이내 안전
   */
  async function uploadVideoChunked(
    file: File,
    onProgress: (chunk: number, total: number) => void,
  ): Promise<void> {
    const CHUNK_SIZE  = 5 * 1024 * 1024; // 5MB
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    for (let i = 0; i < totalChunks; i++) {
      onProgress(i, totalChunks);
      const start = i * CHUNK_SIZE;
      const end   = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      const data  = await blobToBase64(chunk);

      const res = await fetch(`/api/nas/${customer.id}/upload-chunk`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName:    file.name,
          subPath,
          chunkIndex:  i,
          totalChunks,
          fileSize:    file.size,
          data,
        }),
      });

      const rawText = await res.text();
      let json: Record<string, unknown> | null = null;
      try { json = JSON.parse(rawText); } catch { /* ignore */ }
      if (!res.ok) {
        throw new Error(
          (json?.error as string) ?? `청크 ${i + 1}/${totalChunks} 실패: ${rawText.slice(0, 200)}`
        );
      }
    }
  }

  async function handleUpload() {
    if (selectedFiles.length === 0) return;

    // 형식 오류 파일이 있으면 업로드 차단
    if (invalidFmtFiles.length > 0) {
      setResult({
        ok: false,
        msg: `파일명 형식 오류 ${invalidFmtFiles.length}건을 먼저 제거해주세요.`,
      });
      return;
    }

    setUploading(true);
    setResult(null);

    const allErrors: string[] = [];
    let totalUploaded = 0;

    try {
      // ── 1. 썸네일: 5개씩 배치 (JSON+base64, 각 배치 ≈ 3MB < 10MB)
      const thumbList  = uploadableFiles.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(baseName(f)));
      const BATCH_SIZE = 5;
      const thumbBatches: File[][] = [];
      for (let i = 0; i < thumbList.length; i += BATCH_SIZE) {
        thumbBatches.push(thumbList.slice(i, i + BATCH_SIZE));
      }

      for (let bi = 0; bi < thumbBatches.length; bi++) {
        const batch = thumbBatches[bi];
        setResult({
          ok: true,
          msg: `⏳ 썸네일 업로드 중... ${totalUploaded}/${selectedFiles.length}건 (배치 ${bi + 1}/${thumbBatches.length})`,
        });

        const files = await Promise.all(
          batch.map(async (file) => ({ name: file.name, data: await blobToBase64(file) }))
        );

        const res     = await fetch(`/api/nas/${customer.id}/upload-local`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ subPath, files }),
        });
        const rawText = await res.text();
        let data: Record<string, unknown> | null = null;
        try { data = JSON.parse(rawText); } catch { /* ignore */ }

        if (!res.ok || !data) {
          setResult({ ok: false, msg: `썸네일 배치 ${bi + 1} 실패: ${(data?.error as string) ?? rawText.slice(0, 200)}` });
          return;
        }
        totalUploaded += (data.uploaded as number) ?? 0;
        if (data.errors) allErrors.push(...(data.errors as string[]));
      }

      // ── 2. 영상: 1개씩 5MB 청크 분할 업로드
      const videoList = uploadableFiles.filter((f) => /\.(mp4|mov|avi|mkv)$/i.test(baseName(f)));
      for (let vi = 0; vi < videoList.length; vi++) {
        const file = videoList[vi];
        setResult({
          ok:  true,
          msg: `⏳ 영상 업로드 중... ${vi + 1}/${videoList.length}번째 파일: ${baseName(file)} (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
        });

        try {
          await uploadVideoChunked(file, (chunk, total) => {
            if (total > 1) {
              setResult({
                ok:  true,
                msg: `⏳ 영상 업로드 중... ${vi + 1}/${videoList.length}번째: ${baseName(file)} — 청크 ${chunk + 1}/${total}`,
              });
            }
          });
          totalUploaded++;
        } catch (e: unknown) {
          allErrors.push(`${baseName(file)}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const errMsg = allErrors.length > 0
        ? ` (실패 ${allErrors.length}건: ${allErrors[0]})`
        : "";
      setResult({ ok: true, msg: `${totalUploaded}/${selectedFiles.length}건 업로드 완료${errMsg}` });
      setSelectedFiles([]);
      if (fileInputRef.current)   fileInputRef.current.value   = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
      setTimeout(() => onUploaded(), 800);
    } catch (e: unknown) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        로컬에 저장된 데이터를 NAS에 업로드합니다.
        파일 형식: <code className="text-amber-400">카메라ID_이벤트명_YYYYMMDD_HHMMSS.ext</code>
      </p>

      {/* 서브 경로 (고객사명으로 고정) */}
      <div className="max-w-sm">
        <label className="block text-xs text-faint mb-1">NAS 서브 경로</label>
        <div className="px-3 py-1.5 bg-input/50 border border-line2 rounded-lg text-xs text-amber-400 font-mono">
          {subPath}
        </div>
        <p className="text-xs text-faint mt-1">
          저장 위치: {(customer.nasPath ?? "/rtpulse")}/{subPath}/video/ 또는 /thumbnail/
        </p>
      </div>

      {/* 파일 선택 — 단일 파일 or 폴더 */}
      <div className="space-y-2">
        <label className="block text-xs text-faint">파일 선택</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 text-xs bg-input text-ink2 border border-line2 rounded-lg hover:bg-gray-700"
          >
            📄 파일 선택
          </button>
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            className="px-3 py-1.5 text-xs bg-input text-ink2 border border-line2 rounded-lg hover:bg-gray-700"
          >
            📁 폴더 선택
          </button>
        </div>

        {/* hidden inputs */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.avi,.mkv"
          onChange={handleFileChange}
          className="hidden"
        />
        {/* webkitdirectory: useEffect에서 직접 setAttribute로 주입 */}
        <input
          ref={folderInputRef}
          type="file"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* 선택된 파일 요약 */}
      {selectedFiles.length > 0 && (
        <div className="bg-panel border border-line rounded-lg p-3 space-y-1.5 text-xs">
          <p className="text-muted font-medium">선택된 파일 {selectedFiles.length}개</p>
          <div className="flex gap-4 flex-wrap text-faint">
            {uploadableFiles.filter((f) => /\.(mp4|mov|avi|mkv)$/i.test(baseName(f))).length > 0 && (
              <span className="text-cyan-600">🎬 영상 {uploadableFiles.filter((f) => /\.(mp4|mov|avi|mkv)$/i.test(baseName(f))).length}개</span>
            )}
            {uploadableFiles.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(baseName(f))).length > 0 && (
              <span className="text-amber-600">🖼 썸네일 {uploadableFiles.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(baseName(f))).length}개</span>
            )}
            {otherFiles.length > 0 && (
              <span className="text-faint">❓ 미지원 확장자 {otherFiles.length}개 (건너뜀)</span>
            )}
            {invalidFmtFiles.length > 0 && (
              <span className="text-red-500 font-semibold">⛔ 형식 오류 {invalidFmtFiles.length}개</span>
            )}
          </div>

          {/* 형식 오류 안내 */}
          {invalidFmtFiles.length > 0 && (
            <div className="mt-1.5 px-3 py-2 bg-red-950/40 border border-red-800/60 rounded-lg space-y-1">
              <p className="text-red-400 font-medium">⛔ 파일명 형식 오류 — 업로드 불가</p>
              <p className="text-red-600">
                필수 형식: <code className="text-red-400">카메라ID_이벤트명_YYYYMMDD_HHMMSS.ext</code>
              </p>
              <p className="text-red-700 text-[10px]">예) 189_intrusion_20260419_205033.jpg</p>
              <div className="max-h-20 overflow-y-auto space-y-0.5 mt-1">
                {invalidFmtFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-red-500 font-mono">
                    <span>✕</span>
                    <span className="truncate">{baseName(f)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 파일 목록 (최대 20개) */}
          <div className="max-h-32 overflow-y-auto space-y-0.5 mt-1">
            {selectedFiles.slice(0, 20).map((f, i) => {
              const bn      = baseName(f);
              const isOther = !/\.(mp4|mov|avi|mkv|jpg|jpeg|png|webp)$/i.test(bn);
              const isInvalid = !isOther && !isValidFileName(f);
              return (
                <div
                  key={i}
                  className={`flex items-center gap-2 ${
                    isInvalid ? "text-red-600" : isOther ? "text-faint" : "text-faint"
                  }`}
                >
                  <span>
                    {isInvalid ? "⛔" : /\.(mp4|mov|avi|mkv)$/i.test(bn) ? "🎬" : /\.(jpg|jpeg|png|webp)$/i.test(bn) ? "🖼" : "❓"}
                  </span>
                  <span className="font-mono truncate">{bn}</span>
                  <span className="shrink-0 text-[10px]">
                    ({(f.size / 1024 / 1024).toFixed(1)}MB)
                    {isInvalid && <span className="ml-1 text-red-500">형식 오류</span>}
                    {isOther   && <span className="ml-1 text-faint">건너뜀</span>}
                  </span>
                </div>
              );
            })}
            {selectedFiles.length > 20 && (
              <p className="text-faint">... 외 {selectedFiles.length - 20}개</p>
            )}
          </div>
        </div>
      )}

      <button
        onClick={handleUpload}
        disabled={selectedFiles.length === 0 || uploading || uploadableFiles.length === 0 || invalidFmtFiles.length > 0}
        title={invalidFmtFiles.length > 0 ? "파일명 형식 오류를 해결 후 업로드하세요" : undefined}
        className="flex items-center gap-2 px-4 py-2 bg-amber-800/60 text-amber-300 border border-amber-700 rounded-lg text-sm hover:bg-amber-800 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span>⬆</span> {uploading ? "업로드 중..." : "NAS 업로드"}
      </button>

      {result && (
        <p className={`text-xs ${result.ok ? "text-green-400" : "text-red-400"}`}>
          {result.ok ? "✓" : "✕"} {result.msg}
        </p>
      )}
    </div>
  );
}

// ─── NAS List (SFTP 스캔 기반) ────────────────────────────────────────────────

const PAGE_SIZE = 50;

function NasList({
  customer, subPath, setSubPath, onRegistered,
}: {
  customer: Customer;
  subPath: string;
  setSubPath: (v: string) => void;
  onRegistered: () => void;
}) {
  const [entries,    setEntries]    = useState<NasEntry[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  const [detections, setDetections] = useState<Record<string, DetectionResult>>({});
  const [labelNames, setLabelNames] = useState<Record<string, string | null>>({});
  const [savingDet,  setSavingDet]  = useState<string | null>(null);

  // 썸네일 640×480 상세보기
  const [thumbPreview, setThumbPreview] = useState<{ url: string; title: string } | null>(null);

  // 필터
  const [filterEvent,    setFilterEvent]    = useState("");
  const [filterCam,      setFilterCam]      = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo,   setFilterDateTo]   = useState("");

  // 페이지네이션
  const [page, setPage] = useState(0);

  // 선택 / 등록 상태
  const [filterDet,     setFilterDet]     = useState<"all" | "TP" | "FP" | "TN" | "FN" | "none">("all");
  const [selected,      setSelected]      = useState<Set<string>>(new Set());
  const [registered,    setRegistered]    = useState<Set<string>>(new Set());
  const [registering,   setRegistering]   = useState(false);
  const [regResult,     setRegResult]     = useState<{ ok: boolean; msg: string } | null>(null);
  const [downloading,   setDownloading]   = useState(false);

  const loadDetections = useCallback(async () => {
    try {
      const r = await fetch(`/api/nas/${customer.id}/detection-result`);
      if (r.ok) {
        const d = await r.json();
        setDetections(d.results    ?? {});
        setLabelNames(d.labelNames ?? {});
      }
    } catch { /* ignore */ }
  }, [customer.id]);

  const loadRegistered = useCallback(async (sp: string) => {
    try {
      const qs = sp ? `?subPath=${encodeURIComponent(sp)}` : "";
      const r  = await fetch(`/api/nas/${customer.id}/register-events${qs}`);
      if (r.ok) {
        const data = await r.json();
        setRegistered(new Set<string>(data.registered ?? []));
      }
    } catch { /* ignore */ }
  }, [customer.id]);

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
        await Promise.all([loadDetections(), loadRegistered(subPath)]);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [customer.id, subPath, loadDetections, loadRegistered]);

  // 탭 전환 시 subPath가 있으면 자동 로드
  useEffect(() => {
    if (subPath) loadFiles();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 최초 마운트 시 1회 (subPath가 이미 있으면 로드)

  // ── 필터 + 페이지네이션 파생 상태 ─────────────────────────────────────────────
  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (filterCam && !e.cameraId.toLowerCase().includes(filterCam.toLowerCase())) return false;
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

  const totalPages  = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
  const pagedEntries = filteredEntries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // 필터 바뀌면 첫 페이지로
  useEffect(() => { setPage(0); }, [filterCam, filterEvent, filterDateFrom, filterDateTo]);

  // 선택된 항목의 thumbPath 맵 — AutoLabelControls에 전달해 미등록 파일도 라벨링 가능하게
  const selectedThumbPaths = useMemo(() => {
    if (selected.size === 0) return undefined;
    const map: Record<string, string> = {};
    entries.forEach((e) => {
      if (selected.has(e.baseName) && e.thumbPath) map[e.baseName] = e.thumbPath;
    });
    return Object.keys(map).length > 0 ? map : undefined;
  }, [selected, entries]);

  async function saveDetection(baseName: string, result: DetectionResult) {
    const entry = entries.find((e) => e.baseName === baseName);
    setSavingDet(baseName);
    try {
      await fetch(`/api/nas/${customer.id}/detection-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName:  baseName,
          result,
          cameraId:  entry?.cameraId  || null,
          eventName: entry?.eventName || null,
          eventTime: entry?.startTime || null,
          thumbPath: entry?.thumbPath || null,
        }),
      });
      setDetections((prev) => ({ ...prev, [baseName]: result }));
    } finally {
      setSavingDet(null);
    }
  }

  // 체크박스 토글
  function toggleSelect(baseName: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(baseName)) next.delete(baseName);
      else next.add(baseName);
      return next;
    });
  }

  // 현재 페이지 전체 선택/해제
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

  // 선택 항목 DB 등록
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
        // 등록된 항목을 registered Set에 추가
        setRegistered((prev) => {
          const next = new Set(prev);
          for (const e of selectedEntries) next.add(e.baseName);
          return next;
        });
        setSelected(new Set());
        // 등록된 이벤트 탭으로 이동
        setTimeout(() => onRegistered(), 600);
      }
    } catch (e: unknown) {
      setRegResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setRegistering(false);
    }
  }

  // 선택 항목 ZIP 다운로드
  async function downloadZip() {
    if (selected.size === 0) return;
    setDownloading(true);
    try {
      const selectedEntries = entries.filter((e) => selected.has(e.baseName));
      const items = selectedEntries.flatMap((e) => {
        const result = [];
        if (e.hasVideo && e.videoPath)
          result.push({ baseName: e.baseName, videoPath: e.videoPath, videoFile: e.videoFileName });
        if (e.hasThumb && e.thumbPath)
          result.push({ baseName: e.baseName, thumbPath: e.thumbPath, thumbFile: e.thumbFileName });
        return result;
      });

      const zipName = subPath
        ? subPath.replace(/[^\w가-힣-]/g, "_")
        : `${customer.id}_events`;

      const r = await fetch(`/api/nas/${customer.id}/download-zip`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ items, zipName }),
      });

      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert(`다운로드 실패: ${(data as { error?: string }).error ?? r.statusText}`);
        return;
      }

      // Blob → 브라우저 다운로드 트리거
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${zipName}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(`다운로드 오류: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(false);
    }
  }

  const thumbUrl = (path: string) =>
    `/api/nas/${customer.id}/file?path=${encodeURIComponent(path)}&type=thumbnail`;
  const videoUrl = (path: string) =>
    `/api/nas/${customer.id}/file?path=${encodeURIComponent(path)}&type=video`;

  const allSelected  = pagedEntries.length > 0 && pagedEntries.every((e) => selected.has(e.baseName));
  const someSelected = selected.size > 0;

  return (
    <div className="space-y-4">

      {/* 썸네일 640×480 상세보기 모달 */}
      {thumbPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setThumbPreview(null)}
        >
          <div
            className="relative bg-panel border border-line2 rounded-xl shadow-2xl p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setThumbPreview(null)}
              className="absolute -top-3 -right-3 w-7 h-7 rounded-full bg-gray-700 hover:bg-gray-600 text-ink text-sm flex items-center justify-center z-10"
            >
              ✕
            </button>
            <div className="px-2 pt-1 pb-2 text-center">
              <p className="text-sm font-semibold text-ink truncate">{thumbPreview.title}</p>
            </div>
            <Image
              src={thumbPreview.url}
              alt="썸네일 상세"
              width={640}
              height={480}
              className="rounded-lg bg-black object-contain"
              unoptimized
            />
          </div>
        </div>
      )}

      {/* 검색 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <label className="block text-xs text-faint mb-1">NAS 서브 경로</label>
          <div className="px-3 py-1.5 bg-input/50 border border-line2 rounded-lg text-xs text-amber-400 font-mono">
            {subPath}
          </div>
        </div>
        <button
          onClick={loadFiles}
          disabled={loading}
          className="px-3 py-1.5 text-xs bg-input text-amber-400 border border-line2 rounded-lg hover:bg-gray-700 disabled:opacity-40 self-end"
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
              className="px-2 py-1.5 bg-panel border border-line2 rounded text-xs text-ink placeholder-gray-600 w-28 focus:outline-none focus:border-amber-600"
            />
            <input
              type="text"
              placeholder="이벤트 이름 필터"
              value={filterEvent}
              onChange={(e) => setFilterEvent(e.target.value)}
              className="px-2 py-1.5 bg-panel border border-line2 rounded text-xs text-ink placeholder-gray-600 w-32 focus:outline-none focus:border-amber-600"
            />
            <input
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              className="px-2 py-1.5 bg-panel border border-line2 rounded text-xs text-ink focus:outline-none focus:border-amber-600"
            />
            <span className="text-faint text-xs">~</span>
            <input
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              className="px-2 py-1.5 bg-panel border border-line2 rounded text-xs text-ink focus:outline-none focus:border-amber-600"
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
              <span className="text-amber-400"> → 필터 {filteredEntries.length}건</span>
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

            {/* 액션 버튼 (선택 시 표시) */}
            {someSelected && (
              <>
                <span className="text-xs text-amber-400">{selected.size}건 선택됨</span>
                <button
                  onClick={registerSelected}
                  disabled={registering}
                  className="px-3 py-1.5 text-xs bg-green-900/50 text-green-400 border border-green-800 rounded-lg hover:bg-green-900 disabled:opacity-40 whitespace-nowrap"
                >
                  {registering ? "등록 중..." : `✓ 등록 (${selected.size}건)`}
                </button>
                <button
                  onClick={downloadZip}
                  disabled={downloading || selected.size > 30}
                  title={selected.size > 30 ? "최대 30건까지 가능합니다" : undefined}
                  className="px-3 py-1.5 text-xs bg-blue-50 border border-blue-400 text-blue-700 rounded-lg hover:bg-blue-100 disabled:opacity-40 whitespace-nowrap dark:bg-blue-900/50 dark:text-blue-400 dark:border-blue-800 dark:hover:bg-blue-900"
                >
                  {downloading ? "압축 중..." : `⬇ ZIP 다운로드 (${selected.size}건)`}
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
                {/* 전체 선택 체크박스 */}
                <th className="py-2 px-2 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="accent-amber-500 cursor-pointer"
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
                    className={`border-b border-line/50 hover:bg-input/20 cursor-pointer ${isChecked ? "bg-amber-900/10" : ""}`}
                    onClick={() => toggleSelect(entry.baseName)}
                  >
                    {/* 체크박스 */}
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(entry.baseName)}
                        className="accent-amber-500 cursor-pointer"
                      />
                    </td>

                    {/* 썸네일 */}
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      <div className="relative">
                        {entry.hasThumb && entry.thumbPath ? (
                          <div
                            className="w-14 h-10 rounded overflow-hidden bg-input relative cursor-zoom-in hover:opacity-80 transition-opacity"
                            onClick={() => setThumbPreview({ url: thumbUrl(entry.thumbPath!), title: [entry.cameraId, entry.eventName].filter(Boolean).join(" · ") || entry.baseName })}
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
                        {/* 등록됨 뱃지 */}
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

                    {/* 파일 다운로드 */}
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
      {filteredEntries.length > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-1 pt-1">
          <button
            onClick={() => setPage(0)}
            disabled={page === 0}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30"
          >«</button>
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30"
          >‹</button>

          {/* 페이지 번호 (최대 7개 표시) */}
          {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            const startPage = Math.max(0, Math.min(page - 3, totalPages - 7));
            const p = startPage + i;
            return (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`px-2 py-1 text-xs rounded ${
                  p === page
                    ? "bg-amber-800/60 text-amber-300 border border-amber-700"
                    : "text-faint hover:text-gray-300"
                }`}
              >
                {p + 1}
              </button>
            );
          })}

          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page === totalPages - 1}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30"
          >›</button>
          <button
            onClick={() => setPage(totalPages - 1)}
            disabled={page === totalPages - 1}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30"
          >»</button>

          <span className="text-xs text-faint ml-2">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredEntries.length)} / {filteredEntries.length}건
          </span>
        </div>
      )}

      {/* 빈 상태 */}
      {!loading && !error && entries.length === 0 && (
        <div className="py-8 text-center space-y-2">
          {subPath ? (
            <>
              <p className="text-xs text-faint">
                <code className="text-amber-700">{(customer.nasPath ?? "/rtpulse")}/{subPath}</code>
              </p>
              <p className="text-xs text-faint">에 파일이 없습니다.</p>
            </>
          ) : (
            <p className="text-xs text-faint">
              NAS 서브 경로를 입력하고 <strong className="text-faint">조회</strong>를 눌러주세요.
            </p>
          )}
        </div>
      )}

      {/* 필터 결과 없음 */}
      {!loading && !error && entries.length > 0 && filteredEntries.length === 0 && (
        <div className="py-6 text-center">
          <p className="text-xs text-faint">필터 조건에 맞는 파일이 없습니다.</p>
        </div>
      )}
    </div>
  );
}

// ─── Registered Events List ───────────────────────────────────────────────────

interface RegisteredEvent {
  base_name:     string;
  camera_id:     string | null;
  event_name:    string | null;
  start_time:    string | null;
  sub_path:      string;
  video_path:    string | null;
  thumb_path:    string | null;
  video_file:    string | null;
  thumb_file:    string | null;
  registered_at: string;
}

const REG_PAGE_SIZE = 50;

function RegisteredEventsList({ customer }: { customer: Customer }) {
  const [events,      setEvents]      = useState<RegisteredEvent[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState("");
  const [selected,    setSelected]    = useState<Set<string>>(new Set());
  const [deleting,    setDeleting]    = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [detections,  setDetections]  = useState<Record<string, DetectionResult>>({});
  const [labelNames,  setLabelNames]  = useState<Record<string, string | null>>({});
  const [savingDet,   setSavingDet]   = useState<string | null>(null);
  const [filterDet,   setFilterDet]   = useState<"all" | "TP" | "FP" | "TN" | "FN" | "none">("all");
  const [page,        setPage]        = useState(0);

  // 썸네일 640×480 상세보기
  const [thumbPreview, setThumbPreview] = useState<{ url: string; title: string } | null>(null);

  const loadDetections = useCallback(async () => {
    try {
      const r = await fetch(`/api/nas/${customer.id}/detection-result`);
      if (r.ok) {
        const d = await r.json();
        setDetections(d.results    ?? {});
        setLabelNames(d.labelNames ?? {});
      }
    } catch { /* ignore */ }
  }, [customer.id]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError("");
    setSelected(new Set());
    try {
      const r    = await fetch(`/api/nas/${customer.id}/register-events`);
      const data = await r.json();
      if (!r.ok) setError(data.error ?? "로드 실패");
      else {
        setEvents(data.events ?? []);
        await loadDetections();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [customer.id, loadDetections]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // 탐지결과 필터 적용
  const filteredEvents = useMemo(
    () => filterDet === "all"
      ? events
      : events.filter((ev) => {
          const det = detections[ev.base_name] ?? null;
          if (filterDet === "TP")   return det === "TP";
          if (filterDet === "FP")   return det === "FP";
          if (filterDet === "TN")   return det === "TN";
          if (filterDet === "FN")   return det === "FN";
          if (filterDet === "none") return det === null;
          return true;
        }),
    [events, detections, filterDet],
  );

  // 페이지네이션
  const regTotalPages  = Math.max(1, Math.ceil(filteredEvents.length / REG_PAGE_SIZE));
  const pagedRegEvents = filteredEvents.slice(page * REG_PAGE_SIZE, (page + 1) * REG_PAGE_SIZE);

  // 필터 바뀌면 첫 페이지로
  useEffect(() => { setPage(0); }, [filterDet]);

  async function saveDetection(baseName: string, result: DetectionResult, ev?: RegisteredEvent) {
    setSavingDet(baseName);
    try {
      await fetch(`/api/nas/${customer.id}/detection-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName:  baseName,
          result,
          cameraId:  ev?.camera_id  || null,
          eventName: ev?.event_name || null,
          eventTime: ev?.start_time || null,
          thumbPath: ev?.thumb_path || null,
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

  function toggleAll() {
    const allPageSelected = pagedRegEvents.every((e) => selected.has(e.base_name));
    if (allPageSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        pagedRegEvents.forEach((e) => next.delete(e.base_name));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        pagedRegEvents.forEach((e) => next.add(e.base_name));
        return next;
      });
    }
  }

  async function unregisterSelected() {
    if (selected.size === 0) return;
    if (!confirm(`선택한 ${selected.size}건을 등록 해제하시겠습니까?`)) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/nas/${customer.id}/register-events`, {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ baseNames: Array.from(selected) }),
      });
      const data = await r.json();
      if (r.ok) {
        setEvents((prev) => prev.filter((e) => !selected.has(e.base_name)));
        setSelected(new Set());
      } else {
        alert(data.error ?? "삭제 실패");
      }
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function downloadZip() {
    if (selected.size === 0) return;
    setDownloading(true);
    try {
      const selectedEvs = events.filter((e) => selected.has(e.base_name));
      const items = selectedEvs.flatMap((ev) => {
        const arr = [];
        if (ev.video_path)
          arr.push({ baseName: ev.base_name, videoPath: ev.video_path, videoFile: ev.video_file ?? undefined });
        if (ev.thumb_path)
          arr.push({ baseName: ev.base_name, thumbPath: ev.thumb_path, thumbFile: ev.thumb_file ?? undefined });
        return arr;
      });

      const zipName = `registered_events`;
      const r = await fetch(`/api/nas/${customer.id}/download-zip`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ items, zipName }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(`다운로드 실패: ${(d as { error?: string }).error ?? r.statusText}`);
        return;
      }
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${zipName}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(`다운로드 오류: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(false);
    }
  }

  const thumbUrl = (path: string) =>
    `/api/nas/${customer.id}/file?path=${encodeURIComponent(path)}&type=thumbnail`;
  const videoUrl = (path: string) =>
    `/api/nas/${customer.id}/file?path=${encodeURIComponent(path)}&type=video`;

  // registered_at: ISO → 읽기 쉬운 형식
  function fmtDate(iso: string) {
    return iso.replace("T", " ").slice(0, 19);
  }

  const allSelected  = pagedRegEvents.length > 0 && pagedRegEvents.every((e) => selected.has(e.base_name));
  const someSelected = selected.size > 0;

  return (
    <div className="space-y-4">

      {/* 썸네일 640×480 상세보기 모달 */}
      {thumbPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setThumbPreview(null)}
        >
          <div
            className="relative bg-panel border border-line2 rounded-xl shadow-2xl p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setThumbPreview(null)}
              className="absolute -top-3 -right-3 w-7 h-7 rounded-full bg-gray-700 hover:bg-gray-600 text-ink text-sm flex items-center justify-center z-10"
            >
              ✕
            </button>
            <div className="px-2 pt-1 pb-2 text-center">
              <p className="text-sm font-semibold text-ink truncate">{thumbPreview.title}</p>
            </div>
            <Image
              src={thumbPreview.url}
              alt="썸네일 상세"
              width={640}
              height={480}
              className="rounded-lg bg-black object-contain"
              unoptimized
            />
          </div>
        </div>
      )}

      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-muted">
          DB에 등록된 이벤트 목록입니다. 경로와 무관하게 모든 등록 항목이 표시됩니다.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={loadEvents}
            disabled={loading}
            className="px-3 py-1.5 text-xs bg-input text-amber-400 border border-line2 rounded-lg hover:bg-gray-700 disabled:opacity-40"
          >
            {loading ? "로딩 중..." : "↻ 새로고침"}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
          ✕ {error}
        </p>
      )}

      {/* 탐지결과 필터 */}
      {!loading && events.length > 0 && (
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
              const cnt = events.filter((ev) => {
                const det = detections[ev.base_name] ?? null;
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
      )}

      {/* 요약 + 액션 바 */}
      {!loading && events.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs text-faint">
            총 <span className="text-amber-400 font-medium">{events.length}</span>건 등록됨
            {filteredEvents.length !== events.length && (
              <span className="text-amber-600"> → 필터 {filteredEvents.length}건</span>
            )}
            {selected.size > 0 && (
              <span className="text-amber-400"> · {selected.size}건 선택</span>
            )}
          </p>
          {someSelected && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-amber-400">{selected.size}건 선택됨</span>
              <button
                onClick={downloadZip}
                disabled={downloading || selected.size > 30}
                title={selected.size > 30 ? "최대 30건까지 가능합니다" : undefined}
                className="px-3 py-1.5 text-xs bg-blue-50 border border-blue-400 text-blue-700 rounded-lg hover:bg-blue-100 disabled:opacity-40 whitespace-nowrap dark:bg-blue-900/50 dark:text-blue-400 dark:border-blue-800 dark:hover:bg-blue-900/70"
              >
                {downloading ? "압축 중..." : `⬇ ZIP 다운로드 (${selected.size}건)`}
              </button>
              <button
                onClick={unregisterSelected}
                disabled={deleting}
                className="px-3 py-1.5 text-xs bg-red-900/40 text-red-400 border border-red-800 rounded-lg hover:bg-red-900/60 disabled:opacity-40 whitespace-nowrap"
              >
                {deleting ? "해제 중..." : `✕ 등록 해제 (${selected.size}건)`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 테이블 */}
      {filteredEvents.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-faint">
                <th className="py-2 px-2 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="accent-amber-500 cursor-pointer"
                  />
                </th>
                <th className="text-left py-2 px-2 font-medium w-16">썸네일</th>
                <th className="text-left py-2 px-2 font-medium">카메라 ID</th>
                <th className="text-left py-2 px-2 font-medium">이벤트</th>
                <th className="text-left py-2 px-2 font-medium">시작 시각</th>
                <th className="text-left py-2 px-2 font-medium">경로</th>
                <th className="text-left py-2 px-2 font-medium w-28">파일</th>
                <th className="text-left py-2 px-2 font-medium w-24">탐지 결과</th>
                <th className="text-left py-2 px-2 font-medium w-24">라벨링 결과</th>
                <th className="text-left py-2 px-2 font-medium">등록일시</th>
              </tr>
            </thead>
            <tbody>
              {pagedRegEvents.map((ev) => {
                const isChecked = selected.has(ev.base_name);
                return (
                  <tr
                    key={ev.base_name}
                    className={`border-b border-line/50 hover:bg-input/20 cursor-pointer ${isChecked ? "bg-amber-900/10" : ""}`}
                    onClick={() => toggleSelect(ev.base_name)}

                  >
                    {/* 체크박스 */}
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(ev.base_name)}
                        className="accent-amber-500 cursor-pointer"
                      />
                    </td>

                    {/* 썸네일 */}
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      {ev.thumb_path ? (
                        <div
                          className="w-14 h-10 rounded overflow-hidden bg-input relative cursor-zoom-in hover:opacity-80 transition-opacity"
                          onClick={() => setThumbPreview({ url: thumbUrl(ev.thumb_path!), title: (() => { const p = ev.base_name.split("_"); return p.length >= 2 ? `${p[0]} · ${p[1]}` : ev.base_name; })() })}
                        >
                          <Image
                            src={thumbUrl(ev.thumb_path)}
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
                    </td>

                    {/* 카메라 ID */}
                    <td className="py-2 px-2 font-mono text-ink2">{ev.camera_id ?? "-"}</td>

                    {/* 이벤트 */}
                    <td className="py-2 px-2 text-ink2">{ev.event_name ?? "-"}</td>

                    {/* 시작 시각 */}
                    <td className="py-2 px-2 font-mono text-muted whitespace-nowrap">
                      {ev.start_time ?? "-"}
                    </td>

                    {/* 경로 */}
                    <td className="py-2 px-2 font-mono text-faint text-[10px] max-w-[120px] truncate" title={ev.sub_path}>
                      {ev.sub_path || "-"}
                    </td>

                    {/* 파일 다운로드 */}
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-col gap-1">
                        {ev.video_path && (
                          <a
                            href={videoUrl(ev.video_path)}
                            download={ev.video_file ?? ev.base_name}
                            className="px-2 py-0.5 bg-input text-cyan-400 border border-line2 rounded hover:bg-gray-700 text-[10px] whitespace-nowrap"
                          >
                            🎬 영상
                          </a>
                        )}
                        {ev.thumb_path && (
                          <a
                            href={thumbUrl(ev.thumb_path)}
                            download={ev.thumb_file ?? ev.base_name}
                            className="px-2 py-0.5 bg-input text-amber-400 border border-line2 rounded hover:bg-gray-700 text-[10px] whitespace-nowrap"
                          >
                            🖼 썸네일
                          </a>
                        )}
                      </div>
                    </td>

                    {/* 탐지 결과 */}
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const det = detections[ev.base_name] ?? null;
                        return (
                          <select
                            value={det ?? ""}
                            disabled={savingDet === ev.base_name}
                            onChange={(e) => {
                              const val = e.target.value as "TP" | "FP" | "TN" | "FN" | "";
                              saveDetection(ev.base_name, val === "" ? null : val, ev);
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
                        );
                      })()}
                    </td>

                    {/* 라벨링 결과 */}
                    <td className="py-2 px-2">
                      <LabelNameChip name={labelNames[ev.base_name] ?? null} />
                    </td>

                    {/* 등록일시 */}
                    <td className="py-2 px-2 font-mono text-faint text-[10px] whitespace-nowrap">
                      {fmtDate(ev.registered_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 페이지네이션 */}
      {filteredEvents.length > REG_PAGE_SIZE && (
        <div className="flex items-center justify-center gap-1 pt-1">
          <button onClick={() => setPage(0)} disabled={page === 0}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30">«</button>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30">‹</button>

          {Array.from({ length: Math.min(regTotalPages, 7) }, (_, i) => {
            const startPage = Math.max(0, Math.min(page - 3, regTotalPages - 7));
            const p = startPage + i;
            return (
              <button key={p} onClick={() => setPage(p)}
                className={`px-2 py-1 text-xs rounded ${
                  p === page
                    ? "bg-amber-800/60 text-amber-300 border border-amber-700"
                    : "text-faint hover:text-gray-300"
                }`}
              >
                {p + 1}
              </button>
            );
          })}

          <button onClick={() => setPage((p) => Math.min(regTotalPages - 1, p + 1))} disabled={page === regTotalPages - 1}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30">›</button>
          <button onClick={() => setPage(regTotalPages - 1)} disabled={page === regTotalPages - 1}
            className="px-2 py-1 text-xs text-faint hover:text-gray-300 disabled:opacity-30">»</button>

          <span className="text-xs text-faint ml-2">
            {page * REG_PAGE_SIZE + 1}–{Math.min((page + 1) * REG_PAGE_SIZE, filteredEvents.length)} / {filteredEvents.length}건
          </span>
        </div>
      )}

      {/* 빈 상태 */}
      {!loading && !error && events.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-sm text-faint">등록된 이벤트가 없습니다.</p>
          <p className="text-xs text-faint mt-1">
            &ldquo;업로드 완료&rdquo; 탭에서 항목을 선택 후 <strong className="text-faint">등록</strong>하세요.
          </p>
        </div>
      )}
      {/* 필터 결과 없음 */}
      {!loading && !error && events.length > 0 && filteredEvents.length === 0 && (
        <div className="py-8 text-center">
          <p className="text-xs text-faint">필터 조건에 맞는 이벤트가 없습니다.</p>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SubTab({ active, onClick, label, icon }: {
  active: boolean; onClick: () => void; label: string; icon: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-3 text-xs font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-amber-500 text-amber-400"
          : "border-transparent text-faint hover:text-gray-300"
      }`}
    >
      <span>{icon}</span>
      {label}
    </button>
  );
}

function todayKST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function weekAgoKST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000 - 7 * 86400 * 1000).toISOString().slice(0, 10);
}
