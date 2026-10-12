"use client";

import { useCallback, useEffect, useState } from "react";

export const dynamic = "force-dynamic";

interface AuditRow {
  id: number;
  created_at: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string | null;
  target_label: string | null;
  status: "success" | "failure";
  detail: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  create: "생성", update: "수정", delete: "삭제", sync: "동기화",
  "nas-auto-upload": "자동 업로드", "auto-label": "자동 라벨링",
};
const TARGET_LABEL: Record<string, string> = {
  customer: "고객사", prompt: "프롬프트", complaint: "민원", maintenance: "유지보수",
};

function fmt(ts: string): string {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(new Date(ts));
  } catch { return ts; }
}

export default function LogsPage() {
  const [rows, setRows]     = useState<AuditRow[]>([]);
  const [total, setTotal]   = useState(0);
  const [status, setStatus] = useState<"" | "success" | "failure">("");
  const [actor, setActor]   = useState("");
  const [limit, setLimit]   = useState(100);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (status) qs.set("status", status);
      if (actor.trim()) qs.set("actor", actor.trim());
      const res = await fetch(`/api/audit-logs?${qs}`, { cache: "no-store" });
      const d = await res.json() as { rows: AuditRow[]; total: number };
      setRows(d.rows ?? []);
      setTotal(d.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [status, actor, limit]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-bold text-ink">활동 로그</h1>
        <p className="text-xs text-faint mt-0.5">누가 무엇을 생성·수정·삭제했는지, 시스템 작업의 성공/실패 기록</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["", "success", "failure"] as const).map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-lg text-xs border ${status === s ? "border-cyan-500 text-cyan-400 bg-cyan-500/10" : "border-line text-faint hover:text-ink"}`}>
            {s === "" ? "전체" : s === "success" ? "성공" : "실패"}
          </button>
        ))}
        <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="행위자(이메일) 검색"
          className="bg-input border border-line rounded-lg px-3 py-1.5 text-xs text-ink w-56" />
        <button onClick={load} className="px-3 py-1.5 rounded-lg text-xs bg-input border border-line text-faint hover:text-ink">새로고침</button>
        <span className="text-xs text-faint ml-auto">{loading ? "불러오는 중…" : `${rows.length} / ${total}건`}</span>
      </div>

      <div className="border border-line rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-input/70 text-xs text-muted uppercase tracking-wider">
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">시각</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">행위자</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">동작</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">대상</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">상태</th>
                <th className="px-4 py-3 text-left font-medium">상세</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-input/30">
                  <td className="px-4 py-2.5 text-xs text-faint whitespace-nowrap">{fmt(r.created_at)}</td>
                  <td className="px-4 py-2.5 text-xs text-ink2 whitespace-nowrap">{r.actor}</td>
                  <td className="px-4 py-2.5 text-xs text-ink2 whitespace-nowrap">{ACTION_LABEL[r.action] ?? r.action}</td>
                  <td className="px-4 py-2.5 text-xs text-ink2 whitespace-nowrap">
                    {TARGET_LABEL[r.target_type] ?? r.target_type}
                    {r.target_label ? <span className="text-faint"> · {r.target_label}</span> : null}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium ${r.status === "success" ? "text-emerald-500 bg-emerald-500/10" : "text-red-400 bg-red-500/10"}`}>
                      {r.status === "success" ? "성공" : "실패"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-faint max-w-md truncate" title={r.detail ?? ""}>{r.detail}</td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-xs text-faint">기록이 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {rows.length >= limit && rows.length < total && (
        <div className="text-center">
          <button onClick={() => setLimit((l) => l + 100)} className="px-4 py-2 rounded-lg text-xs bg-input border border-line text-faint hover:text-ink">더 보기</button>
        </div>
      )}
    </div>
  );
}
