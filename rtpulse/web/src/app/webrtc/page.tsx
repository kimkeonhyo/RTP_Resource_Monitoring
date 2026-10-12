"use client";

import { useState } from "react";
import * as pako from "pako";
import { analyzeDump } from "@/lib/webrtc/analyzer";
import type { AnalysisSummary, RawDump } from "@/lib/webrtc/types";
import ResultView from "@/components/webrtc/result-view";
import Glossary from "@/components/webrtc/glossary";

/** File 객체에서 RawDump 객체로. .gz 면 gzip 해제, .json 이면 그대로 파싱. */
async function readDumpFile(file: File): Promise<RawDump> {
  const buf = await file.arrayBuffer();
  let text: string;

  // .gz / 첫 두 바이트 0x1f 0x8b → gzip
  const u8 = new Uint8Array(buf);
  const isGzip = file.name.toLowerCase().endsWith(".gz")
    || (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b);

  if (isGzip) {
    text = pako.ungzip(u8, { to: "string" });
  } else {
    text = new TextDecoder("utf-8").decode(buf);
  }
  return JSON.parse(text) as RawDump;
}

export default function WebRTCPage() {
  const [summary, setSummary]   = useState<AnalysisSummary | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [busy, setBusy]         = useState(false);
  const [fileName, setFileName] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    setSummary(null);
    setFileName(file.name);
    try {
      const dump = await readDumpFile(file);
      const result = analyzeDump(dump);
      setSummary(result);
      console.log("[WebRTC] 분석 결과:", result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }

  function reset() {
    setSummary(null);
    setError(null);
    setFileName("");
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* ── 헤더 ── */}
      <header className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-emerald-400">WebRTC 분석</h1>
          <p className="text-sm text-gray-500 mt-1">
            webrtc-internals 덤프 파일(.gz / .json)을 업로드하면 스트림 품질을 분석합니다.
          </p>
        </div>
        {summary && (
          <button
            onClick={reset}
            className="px-3 py-1.5 text-xs bg-input border border-line2 rounded-lg text-gray-300 hover:bg-input/70 transition-colors"
          >
            ↺ 새 파일 분석
          </button>
        )}
      </header>

      {/* ── 업로드 영역 (결과 없을 때 크게 / 있으면 작게) ── */}
      {!summary && (
        <div
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          className={[
            "border-2 border-dashed rounded-xl p-10 text-center transition-all",
            dragOver
              ? "border-emerald-500 bg-emerald-900/20 scale-[1.01]"
              : "border-line2 bg-panel/40 hover:border-emerald-700/60",
          ].join(" ")}
        >
          <div className="text-emerald-500 mb-3">
            <svg className="w-10 h-10 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
          </div>
          <p className="text-sm text-gray-300 mb-1">
            {dragOver ? "여기에 놓으세요!" : "파일을 끌어다 놓거나 아래 버튼으로 선택"}
          </p>
          <p className="text-xs text-gray-600 mb-4">
            지원 포맷: <span className="font-mono">.gz</span> / <span className="font-mono">.json</span>
          </p>
          <label className="inline-block px-4 py-2 bg-emerald-700 text-white rounded-lg text-sm cursor-pointer hover:bg-emerald-600 transition-colors">
            파일 선택
            <input
              type="file"
              accept=".gz,.json,application/gzip,application/json"
              onChange={onChange}
              className="hidden"
            />
          </label>

          {fileName && !error && !busy && (
            <p className="text-xs text-gray-500 mt-3 font-mono">선택됨: {fileName}</p>
          )}
        </div>
      )}

      {/* ── 사용 가이드 (결과 없을 때만) ── */}
      {!summary && !busy && !error && (
        <div className="mt-6 grid md:grid-cols-3 gap-3 text-xs">
          <GuideCard
            title="① 덤프 받기"
            body={<>크롬에서 <span className="font-mono text-emerald-400">chrome://webrtc-internals</span> 열고 우측 상단 <span className="font-mono">Create a dump</span> 클릭.</>}
          />
          <GuideCard
            title="② 업로드"
            body={<>받은 <span className="font-mono">webrtc_internals_dump.gz</span> (또는 <span className="font-mono">.json</span>) 을 위 영역에 드래그.</>}
          />
          <GuideCard
            title="③ 결과 확인"
            body="자동으로 비디오 스트림별 health 점수, 원인(네트워크/디코더/렌더링/복구) 분석 결과가 표시됩니다."
          />
        </div>
      )}

      {/* ── 로딩 ── */}
      {busy && (
        <div className="mt-6 flex items-center gap-3 px-4 py-3 bg-panel border border-line rounded-lg">
          <span className="inline-block w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">분석 중…</span>
          <span className="text-xs text-gray-600 font-mono">{fileName}</span>
        </div>
      )}

      {/* ── 에러 ── */}
      {error && (
        <div className="mt-6 px-4 py-3 bg-rose-900/20 border border-rose-800 rounded-lg flex items-start gap-3">
          <span className="text-rose-400 text-lg leading-none">⚠</span>
          <div className="flex-1">
            <p className="text-sm text-rose-300 font-medium">분석 실패</p>
            <p className="text-xs text-rose-400/80 mt-0.5 font-mono">{error}</p>
            <p className="text-[11px] text-gray-500 mt-2">
              파일이 webrtc-internals 덤프 형식인지, .gz 라면 손상되지 않았는지 확인해주세요.
            </p>
          </div>
        </div>
      )}

      {/* ── 분석 결과 ── */}
      {summary && (
        <div className="mt-2">
          <p className="text-xs text-gray-600 font-mono mb-3">파일: {fileName}</p>
          <ResultView summary={summary} fileName={fileName} />
        </div>
      )}

      {/* ── 용어 설명 (항상 페이지 하단) ── */}
      <Glossary />
    </div>
  );
}

function GuideCard({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-4">
      <p className="text-emerald-400 font-semibold mb-1.5">{title}</p>
      <p className="text-gray-400 leading-relaxed">{body}</p>
    </div>
  );
}
