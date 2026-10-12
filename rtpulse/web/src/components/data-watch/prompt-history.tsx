"use client";

import { useState } from "react";
import useSWR from "swr";
import type { PromptRow } from "@/lib/prompt-history";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** F1 집계 응답 */
interface F1Stat { tp: number; fp: number; fn: number; total: number; f1: number | null }
interface F1Response {
  byCustomer?: Record<string, Record<string, F1Stat>>;
}

function f1Color(f1: number): string {
  if (f1 >= 0.8) return "text-emerald-400";
  if (f1 >= 0.5) return "text-amber-400";
  return "text-red-400";
}

/** /api/prompt-records 가 반환하는 레코드 */
interface PromptRecord {
  id: number;
  project_name: string;
  version: string;
  assignees: string;           // comma-separated
  applied_at: string | null;
  nas_path: string | null;
  csv_path: string | null;
  base_prompt: string | null;
  registered_at: string;
}

interface Props {
  customerId: string;
}

export default function PromptHistory({ customerId }: Props) {
  const [selectedId, setSelectedId] = useState<number | "">("");
  const [preview, setPreview]       = useState<PromptRecord | null>(null);
  const [saving, setSaving]         = useState(false);
  const [msg, setMsg]               = useState<{ ok: boolean; text: string } | null>(null);

  // 이 고객사에 등록된 프롬프트 이력 (customer_prompt_history)
  const { data: history = [], mutate } = useSWR<PromptRow[]>(
    `/api/customers/${customerId}/prompts`,
    fetcher,
    { revalidateOnFocus: false }
  );

  // 전체 프롬프트 레코드 목록 (내부 DB)
  const { data: promptRecords = [], isLoading: recordsLoading } = useSWR<PromptRecord[]>(
    `/api/prompt-records`,
    fetcher,
    { revalidateOnFocus: false }
  );

  // 버전별 F1-Score (이 고객사 기준)
  const { data: f1Data } = useSWR<F1Response>(`/api/prompt-history/f1`, fetcher, { revalidateOnFocus: false });
  const f1ByVersion = f1Data?.byCustomer?.[customerId] ?? {};

  // 이미 등록된 버전명
  const registeredVersions = new Set(history.map((r) => r.version).filter(Boolean));

  function handleSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    if (!val) { setSelectedId(""); setPreview(null); setMsg(null); return; }
    const id = Number(val);
    setSelectedId(id);
    setMsg(null);
    setPreview(promptRecords.find((r) => r.id === id) ?? null);
  }

  async function register() {
    if (!preview) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/customers/${customerId}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notionId:       String(preview.id),
          version:        preview.version,
          basePrompt:     preview.base_prompt ?? "",
          assignees:      preview.assignees
                            ? preview.assignees.split(",").map((s) => s.trim()).filter(Boolean)
                            : [],
          appliedAt:      preview.applied_at ?? null,
          huggingfaceUrl: preview.nas_path ?? null,   // NAS 경로를 이 필드에 저장
          notionUrl:      "",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ ok: false, text: data.error ?? "등록 실패" });
      } else {
        await mutate();
        setSelectedId("");
        setPreview(null);
        setMsg({ ok: true, text: "등록됐습니다." });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "등록 실패" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    await fetch(`/api/customers/${customerId}/prompts/${id}`, { method: "DELETE" });
    await mutate();
  }

  async function toggleActive(r: PromptRow) {
    await fetch(`/api/customers/${customerId}/prompts/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !r.isActive }),
    });
    await mutate();
  }

  return (
    <div className="space-y-4">
      {/* ── 등록 폼 ── */}
      <div className="border border-line rounded-xl p-4 space-y-3">
        <p className="text-xs text-faint font-medium">프롬프트 등록</p>

        <div className="flex items-center gap-3">
          <select
            value={selectedId}
            onChange={handleSelect}
            disabled={recordsLoading}
            className="flex-1 bg-panel border border-line2 text-gray-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-cyan-600"
          >
            <option value="">{recordsLoading ? "불러오는 중…" : "— 프롬프트 선택 —"}</option>
            {promptRecords.map((r) => {
              const alreadyIn = registeredVersions.has(r.version);
              return (
                <option key={r.id} value={r.id} disabled={alreadyIn}>
                  {r.version} — {r.project_name}
                  {alreadyIn ? "  (이미 등록됨)" : ""}
                </option>
              );
            })}
          </select>

          <button
            onClick={register}
            disabled={!preview || saving || registeredVersions.has(preview?.version ?? "")}
            className="px-4 py-2 text-xs bg-cyan-700 text-white rounded-lg hover:bg-cyan-600 disabled:opacity-40 whitespace-nowrap"
          >
            {saving ? "등록 중…" : "등록"}
          </button>
        </div>

        {/* 선택 미리보기 */}
        {preview && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs bg-panel/40 border border-line rounded-lg p-3">
            <InfoRow label="프로젝트명"  value={preview.project_name || "—"} />
            <InfoRow label="버전명"      value={preview.version || "—"} mono />
            <InfoRow label="Base Prompt" value={preview.base_prompt || "—"} mono />
            <InfoRow label="담당자"      value={preview.assignees || "—"} />
            <InfoRow label="VMS 적용일" value={preview.applied_at?.slice(0, 10) ?? "—"} mono />
            {preview.nas_path && (
              <div className="flex items-start gap-2 col-span-2">
                <span className="text-faint w-28 shrink-0">JSON 파일</span>
                <span className="font-mono text-muted break-all">{preview.nas_path}</span>
              </div>
            )}
          </div>
        )}

        {msg && (
          <p className={`text-xs ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</p>
        )}
      </div>

      {/* ── 이력 테이블 ── */}
      <div className="border border-line rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-faint bg-panel/20">
                <th className="px-3 py-2.5 text-center whitespace-nowrap">사용</th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">버전명</th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">Base Prompt</th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">담당자</th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">VMS 적용일</th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">F1-Score</th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">JSON 파일</th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">등록일</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-faint">
                    등록된 프롬프트가 없습니다.
                  </td>
                </tr>
              )}
              {history.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-line/50 transition-colors ${
                    r.isActive ? "bg-cyan-950/20" : "hover:bg-input/30"
                  }`}
                >
                  {/* 사용 중 토글 */}
                  <td className="px-3 py-2.5 text-center">
                    <input
                      type="checkbox"
                      checked={r.isActive}
                      onChange={() => toggleActive(r)}
                      className="accent-cyan-500 cursor-pointer"
                      title={r.isActive ? "사용 중" : "사용으로 설정"}
                    />
                  </td>
                  {/* 버전명 */}
                  <td className="px-3 py-2.5 font-mono text-cyan-400 font-semibold whitespace-nowrap">
                    {r.version || "—"}
                    {r.isActive && (
                      <span className="ml-2 text-[10px] bg-cyan-900/60 text-cyan-400 border border-cyan-800 rounded px-1 py-0.5">
                        사용 중
                      </span>
                    )}
                  </td>
                  {/* Base Prompt */}
                  <td className="px-3 py-2.5 font-mono text-muted max-w-[160px] truncate">
                    {r.basePrompt || "—"}
                  </td>
                  {/* 담당자 */}
                  <td className="px-3 py-2.5 text-muted">
                    {r.assignees.join(", ") || "—"}
                  </td>
                  {/* VMS 적용일 */}
                  <td className="px-3 py-2.5 text-faint font-mono whitespace-nowrap">
                    {r.appliedAt ?? "—"}
                  </td>
                  {/* F1-Score */}
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {(() => {
                      const stat = r.version ? f1ByVersion[r.version] : undefined;
                      if (!stat || stat.f1 === null) return <span className="text-faint">—</span>;
                      return (
                        <span
                          className={`font-mono font-semibold ${f1Color(stat.f1)}`}
                          title={`정탐 ${stat.tp} · 오탐 ${stat.fp} · 미탐 ${stat.fn}`}
                        >
                          {stat.f1.toFixed(3)}
                        </span>
                      );
                    })()}
                  </td>
                  {/* NAS 경로 (huggingfaceUrl 필드에 저장) */}
                  <td className="px-3 py-2.5 max-w-[200px]" title={r.huggingfaceUrl ?? undefined}>
                    {r.huggingfaceUrl ? (
                      <span className="font-mono text-faint text-[10px] truncate block">
                        {r.huggingfaceUrl}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  {/* 등록일 */}
                  <td className="px-3 py-2.5 text-faint font-mono whitespace-nowrap">
                    {r.registeredAt.slice(0, 10)}
                  </td>
                  {/* 삭제 */}
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => remove(r.id)}
                      className="text-faint hover:text-red-400 text-xs"
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-faint w-28 shrink-0">{label}</span>
      <span className={`${mono ? "font-mono" : ""} text-ink2`}>{value}</span>
    </div>
  );
}
