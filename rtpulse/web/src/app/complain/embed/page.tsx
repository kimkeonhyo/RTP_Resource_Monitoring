"use client";

import { useEffect, useState } from "react";
import { getCategory, statusBadgeClass } from "@/lib/complain-categories";

export const dynamic = "force-dynamic";

interface Card {
  id: number;
  customer_name: string;
  applicant_name: string;
  email: string;
  phone: string;
  job_title: string;
  title: string;
  status: string;
  category: string;
  phenomenon: string;
  action_method: string;
  action_result: string;
  received_at: string;
  resolved_at: string | null;
  created_at: string;
}

type State =
  | { kind: "waiting" }
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "error"; msg: string }
  | { kind: "card"; card: Card };

export default function ComplainEmbed() {
  const [state, setState] = useState<State>({ kind: "waiting" });
  const [token, setToken] = useState("");
  const [convId, setConvId] = useState("");

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") || "";
    setToken(t);

    const fetchCard = async (conversationId: string | number) => {
      setConvId(String(conversationId));
      setState({ kind: "loading" });
      try {
        const res = await fetch(
          `/api/helpdesk/card?external_id=chatwoot:${conversationId}&token=${encodeURIComponent(t)}`
        );
        if (!res.ok) return setState({ kind: "error", msg: `조회 실패 (${res.status})` });
        const data = (await res.json()) as { found: boolean; card?: Card };
        setState(data.found && data.card ? { kind: "card", card: data.card } : { kind: "none" });
      } catch {
        setState({ kind: "error", msg: "네트워크 오류" });
      }
    };

    const onMessage = (e: MessageEvent) => {
      try {
        const payload = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (!payload || payload.event !== "appContext") return;
        const conv = payload.data?.conversation;
        const convId = conv?.id ?? conv?.display_id ?? conv?.meta?.id;
        if (convId) fetchCard(convId);
      } catch { /* ignore */ }
    };
    window.addEventListener("message", onMessage);

    const directId = new URLSearchParams(window.location.search).get("conversation_id");
    if (directId) fetchCard(directId);

    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="min-h-screen bg-[#0f1729] text-gray-100 p-4 text-sm">
      {state.kind === "waiting" && <p className="text-gray-400">대화 정보를 불러오는 중…</p>}
      {state.kind === "loading" && <p className="text-gray-400">카드 조회 중…</p>}
      {state.kind === "none" && <p className="text-gray-400">연결된 HELPDESK 카드가 없습니다.</p>}
      {state.kind === "error" && <p className="text-red-400">{state.msg}</p>}
      {state.kind === "card" && <CardEditor card={state.card} token={token} convId={convId} />}
    </div>
  );
}

const inputCls = "w-full bg-[#1b2740] border border-white/10 rounded px-2 py-1.5 text-gray-100 focus:outline-none focus:border-cyan-600";

/** 모듈 레벨 컴포넌트 — 부모 리렌더 시 remount되지 않아 입력 포커스가 유지됨 */
function EditField({ label, value, onChange, rows = 2 }: {
  label: string; value: string; onChange: (v: string) => void; rows?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs text-gray-400">{label}</span>
      <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} resize-y mt-0.5`} />
    </label>
  );
}

function CardEditor({ card, token, convId }: { card: Card; token: string; convId: string }) {
  const cfg = getCategory(card.category);
  const [form, setForm] = useState({
    status: card.status,
    title: card.title || "",
    phenomenon: card.phenomenon || "",
    action_method: card.action_method || "",
    action_result: card.action_result || "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (k: keyof typeof form, v: string) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  const save = async () => {
    setSaving(true); setSaved(false);
    try {
      const res = await fetch(`/api/helpdesk/card?token=${encodeURIComponent(token)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ external_id: `chatwoot:${convId}`, ...form }),
      });
      setSaved(res.ok);
      if (!res.ok) alert(`저장 실패 (${res.status})`);
    } catch { alert("저장 실패"); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs px-2 py-0.5 rounded bg-white/10">{cfg.label}</span>
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${statusBadgeClass(form.status)}`}>{form.status}</span>
      </div>

      {/* 연락처 정보 (읽기 전용) */}
      <div className="text-xs space-y-0.5 text-gray-300">
        <div><span className="text-gray-500">고객사</span> {card.customer_name || "-"} · <span className="text-gray-500">신청자</span> {card.applicant_name || "-"}{card.job_title ? ` (${card.job_title})` : ""}</div>
        <div><span className="text-gray-500">연락처</span> {card.phone || "-"} · <span className="text-gray-500">이메일</span> {card.email || "-"}</div>
      </div>

      {/* 진행 상태 */}
      <label className="block">
        <span className="text-xs text-gray-400">진행 상태</span>
        <select value={form.status} onChange={(e) => set("status", e.target.value)} className={`${inputCls} mt-0.5`}>
          {cfg.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>

      <EditField label={cfg.titleLabel} value={form.title} onChange={(v) => set("title", v)} rows={2} />
      <EditField label="현상" value={form.phenomenon} onChange={(v) => set("phenomenon", v)} rows={2} />
      <EditField label="조치 방법" value={form.action_method} onChange={(v) => set("action_method", v)} rows={2} />
      <EditField label="조치 결과" value={form.action_result} onChange={(v) => set("action_result", v)} rows={2} />

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={saving}
          className="px-3 py-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white rounded">
          {saving ? "저장 중…" : "저장"}
        </button>
        {saved && <span className="text-xs text-green-400">저장됨 ✓</span>}
        <a href={`/complain/${card.id}`} target="_blank" rel="noreferrer"
          className="ml-auto text-cyan-400 hover:text-cyan-300 text-xs">전체 카드 #{card.id} →</a>
      </div>
    </div>
  );
}