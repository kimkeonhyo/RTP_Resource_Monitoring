"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import PromptDomainTable from "./prompt-domain-table";

const SETTING_KEY = "prompt-guide";

const DEFAULT_CONTENT = `## 개요

VMS 프롬프트는 AI 카메라의 이벤트 감지 기준을 정의하는 핵심 설정 파일입니다.
프로젝트별·버전별로 체계적으로 관리하며, JSON 형식으로 NAS에 저장됩니다.

---

## 관리 절차

1. **프롬프트 작성** — JSON 스펙에 맞게 프롬프트 파일을 작성하고 버전을 부여합니다.
2. **NAS 등록** — [프롬프트 기록] 탭에서 JSON 파일을 업로드하면 NAS에 자동 저장되고 기록이 등록됩니다.
3. **현장 적용** — VMS 장비에서 해당 버전을 선택하여 배포합니다. VMS 적용 일자를 기록합니다.

---

## NAS 저장 경로

\`\`\`
/rtpulse/prompts/text_features_{버전명}.json
\`\`\`

> 환경변수 \`NAS_PROMPT_BASE\`로 기본 경로를 변경할 수 있습니다.`;

// ── Markdown 렌더링 컴포넌트 커스터마이징 ────────────────────────────────────

const mdComponents: Components = {
  h1: ({ children }) => (
    <h1 className="text-lg font-bold text-ink mt-6 mb-3 pb-2 border-b border-line2">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-semibold text-purple-300 mt-5 mb-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold text-gray-200 mt-4 mb-1.5">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="text-sm text-ink2 leading-relaxed mb-3">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="list-disc list-inside space-y-1 mb-3 text-sm text-ink2 pl-2">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside space-y-1.5 mb-3 text-sm text-ink2 pl-2">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="leading-relaxed">{children}</li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-ink">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic text-muted">{children}</em>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className="block bg-canvas border border-line2 rounded-lg px-4 py-3 text-xs font-mono text-green-300 leading-relaxed whitespace-pre overflow-x-auto">
          {children}
        </code>
      );
    }
    return (
      <code className="bg-input border border-line2 rounded px-1.5 py-0.5 text-xs font-mono text-cyan-300">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-3">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-purple-600 pl-4 my-3 text-muted italic text-sm">
      {children}
    </blockquote>
  ),
  hr: () => (
    <hr className="border-line2 my-4" />
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-3">
      <table className="w-full text-xs border border-line2 rounded-lg overflow-hidden">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-input text-muted">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-line">{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr className="hover:bg-input/30">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 text-ink2">{children}</td>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 transition-colors"
    >
      {children}
    </a>
  ),
};

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function PromptIntro() {
  const [content, setContent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState("");
  const [saving, setSaving]   = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/site-settings/${SETTING_KEY}`)
      .then((r) => r.json())
      .then((d) => setContent(d.value ?? DEFAULT_CONTENT))
      .catch(() => setContent(DEFAULT_CONTENT));
  }, []);

  const startEdit = () => {
    setDraft(content ?? DEFAULT_CONTENT);
    setSaveErr(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveErr(null);
  };

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch(`/api/site-settings/${SETTING_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: draft }),
      });
      if (!res.ok) throw new Error("저장 실패");
      setContent(draft);
      setEditing(false);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 text-sm text-ink2">
      {/* 헤더 */}
      <div className="border border-purple-800/50 rounded-xl p-6 bg-panel/60">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-2xl">🧠</span>
          <div>
            <h1 className="text-lg font-bold text-ink tracking-tight">VMS 프롬프트 관리 시스템</h1>
            <p className="text-xs text-faint mt-0.5">Modular AI Camera System — Prompt Versioning &amp; NAS Management</p>
          </div>
        </div>
      </div>

      {/* 버전 체계 — 고정 구조 테이블 */}
      <section>
        <h2 className="text-sm font-semibold text-purple-400 uppercase tracking-widest mb-3">버전 체계</h2>
        <div className="border border-line2 rounded-lg overflow-hidden">
          <div className="bg-input px-5 py-3 font-mono text-base text-ink tracking-wider text-center">
            v<span className="text-purple-400">(classes)</span>.<span className="text-cyan-400">(model)</span>.<span className="text-green-400">(domain)</span>.<span className="text-yellow-400">(patch)</span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line2 bg-input/50">
                <th className="px-5 py-2 text-left text-muted font-medium w-20">자리</th>
                <th className="px-5 py-2 text-left text-muted font-medium w-28">기호</th>
                <th className="px-5 py-2 text-left text-muted font-medium">의미</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              <tr>
                <td className="px-5 py-2.5 text-faint">1번째</td>
                <td className="px-5 py-2.5 font-mono text-purple-400">classes</td>
                <td className="px-5 py-2.5 text-ink2">감지 클래스 구조 변경 시 증가</td>
              </tr>
              <tr>
                <td className="px-5 py-2.5 text-faint">2번째</td>
                <td className="px-5 py-2.5 font-mono text-cyan-400">model</td>
                <td className="px-5 py-2.5 text-ink2">모델 아키텍처 또는 가중치 변경 시 증가</td>
              </tr>
              <tr>
                <td className="px-5 py-2.5 text-faint">3번째</td>
                <td className="px-5 py-2.5 font-mono text-green-400">domain</td>
                <td className="px-5 py-2.5 text-ink2">적용 도메인 / 현장 변경 시 증가</td>
              </tr>
              <tr>
                <td className="px-5 py-2.5 text-faint">4번째</td>
                <td className="px-5 py-2.5 font-mono text-yellow-400">patch</td>
                <td className="px-5 py-2.5 text-ink2">현장 배포 패치 번호</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-faint">
          예: <span className="font-mono text-muted">v1.0.0.5</span> → classes 1, 기본 모델, 기본 도메인, 패치 5
        </p>
      </section>

      {/* 도메인 / 클래스 매핑 테이블 */}
      <PromptDomainTable />

      {/* 편집 가능 가이드 섹션 */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-purple-400 uppercase tracking-widest">가이드</h2>
          {!editing && (
            <button
              onClick={startEdit}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted hover:text-ink border border-line2 hover:border-gray-500 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              편집
            </button>
          )}
        </div>

        {content === null ? (
          <div className="text-xs text-faint animate-pulse">불러오는 중...</div>
        ) : editing ? (
          <div className="space-y-3">
            {/* Markdown 힌트 */}
            <div className="flex items-center gap-2 text-xs text-faint">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>
                <span className="text-faint">Markdown</span> 형식으로 작성할 수 있습니다.&nbsp;
                <code className="bg-input px-1 py-0.5 rounded text-faint">**굵게**</code>,&nbsp;
                <code className="bg-input px-1 py-0.5 rounded text-faint"># 제목</code>,&nbsp;
                <code className="bg-input px-1 py-0.5 rounded text-faint">```코드블록```</code>,&nbsp;
                <code className="bg-input px-1 py-0.5 rounded text-faint">- 목록</code> 등을 사용할 수 있습니다.
              </span>
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={20}
              className="w-full bg-canvas border border-purple-800/60 rounded-lg px-4 py-3 text-sm text-gray-200 font-mono leading-relaxed placeholder:text-faint focus:outline-none focus:border-purple-600 resize-y"
              placeholder="Markdown 형식으로 가이드 내용을 입력하세요..."
            />
            {saveErr && (
              <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded px-3 py-2">{saveErr}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={cancelEdit}
                disabled={saving}
                className="px-4 py-2 rounded-lg text-sm text-muted hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-50"
              >
                취소
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm bg-purple-700 hover:bg-purple-600 text-white font-medium transition-colors disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full" />
                    저장 중...
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    저장
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="border border-line rounded-lg px-6 py-5 bg-panel/30">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {content}
            </ReactMarkdown>
          </div>
        )}
      </section>
    </div>
  );
}
