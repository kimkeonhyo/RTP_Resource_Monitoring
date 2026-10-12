"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CustomerStatus } from "@/lib/types";
import type { K8sStatusResult } from "@/app/api/customers/[id]/k8s-status/route";
import clsx from "clsx";


// ── 리소스 프로그레스 바 ──────────────────────────────────────────────────────

function ResourceBar({
  label,
  pct,
  usage,
  barColor,
  textColor,
}: {
  label:     string;
  pct:       number;
  usage?:    string;
  barColor:  string;
  textColor: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between items-center text-[10px]">
        <span className="text-faint">{label}</span>
        <span className={textColor}>
          {usage ? `${usage} · ` : ""}{pct}%
        </span>
      </div>
      <div className="h-1 bg-input rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}


// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function CustomerCard({ status }: { status: CustomerStatus }) {
  const router = useRouter();
  const [deleting,     setDeleting]     = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [liveStatus,   setLiveStatus]   = useState<CustomerStatus>(status);
  const [k8sData,      setK8sData]      = useState<K8sStatusResult | null>(null);

  const { customer } = liveStatus;
  const { aggregate, reachable, error } = liveStatus;

  // 연결된 고객사에 한해 K8s 리소스 메트릭 조회
  useEffect(() => {
    if (!reachable) { setK8sData(null); return; }
    let cancelled = false;
    fetch(`/api/customers/${customer.id}/k8s-status`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: K8sStatusResult) => { if (!cancelled) setK8sData(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [customer.id, reachable]);

  // Ready 노드의 평균 CPU / Memory 퍼센트
  const readyNodes  = k8sData?.nodes.filter((n) => n.status === "Ready") ?? [];
  const nodesWithCpu = readyNodes.filter((n) => n.cpuPct != null);
  const nodesWithMem = readyNodes.filter((n) => n.memPct != null);

  const avgCpuPct = nodesWithCpu.length
    ? Math.round(nodesWithCpu.reduce((s, n) => s + (n.cpuPct ?? 0), 0) / nodesWithCpu.length)
    : null;
  const avgMemPct = nodesWithMem.length
    ? Math.round(nodesWithMem.reduce((s, n) => s + (n.memPct ?? 0), 0) / nodesWithMem.length)
    : null;

  // 노드 데이터 없으면 systemMemory 로 폴백
  const sysMem    = k8sData?.systemMemory;
  const sysMemPct = sysMem
    ? Math.round((sysMem.usedMb / sysMem.totalMb) * 100)
    : null;

  const cpuPct = avgCpuPct;
  const memPct = avgMemPct ?? sysMemPct;

  // CPU usage 레이블 (노드 1개일 때만 표시)
  const cpuUsageLabel = nodesWithCpu.length === 1 ? nodesWithCpu[0].cpuUsage : undefined;
  const memUsageLabel = nodesWithMem.length === 1 ? nodesWithMem[0].memUsage : undefined;

  const showBars = k8sData?.sshReachable && (cpuPct != null || memPct != null);

  async function handleReconnect(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setReconnecting(true);
    try {
      const res  = await fetch(`/api/customers/${customer.id}/ping`, { method: "POST" });
      const data = await res.json() as CustomerStatus;
      setLiveStatus(data);
    } catch {
      // 네트워크 오류 → 현재 상태 유지
    } finally {
      setReconnecting(false);
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`"${customer.name}"을(를) 삭제하시겠습니까?`)) return;
    setDeleting(true);
    await fetch(`/api/customers/${customer.id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="group relative bg-panel border border-line rounded-xl p-4 hover:border-gray-600 transition-colors">
      {/* 삭제 버튼 */}
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1.5 text-faint hover:text-red-400 hover:bg-red-950/40 rounded-lg transition-all disabled:opacity-30"
        title="고객사 삭제"
      >
        {deleting ? (
          <span className="text-xs text-faint">삭제 중</span>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        )}
      </button>

      <Link href={`/customers/${customer.id}`} className="block">
        {/* ── 헤더: 고객사명 + IP + 상태 뱃지 ── */}
        <div className="flex items-start justify-between mb-3 pr-6">
          <div>
            <h3 className="font-semibold text-ink">{customer.name}</h3>
            {customer.ip && (
              <p className="text-xs text-faint mt-0.5 font-mono">{customer.ip}</p>
            )}
          </div>
          <span
            className={clsx(
              "text-xs px-2.5 py-0.5 rounded-full border shrink-0 flex items-center gap-1.5",
              reachable
                ? "text-green-700 border-green-400 bg-green-100 dark:text-green-400 dark:border-green-800 dark:bg-green-950"
                : "text-red-700 border-red-400 bg-red-100 dark:text-red-400 dark:border-red-800 dark:bg-red-950"
            )}
          >
            <span className={clsx(
              "w-1.5 h-1.5 rounded-full",
              reachable ? "bg-green-400" : "bg-red-400"
            )} />
            {reachable ? "연결됨" : "연결 실패"}
          </span>
        </div>

        {/* ── 스트림 통계 그리드 ── */}
        {reachable && aggregate ? (
          <div className="space-y-3">
            {/* 섹션 레이블 */}
            <div className="flex items-center gap-1.5">
              <svg className="w-3 h-3 text-cyan-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.868v6.264a1 1 0 01-1.447.894L15 14M4 8a1 1 0 011-1h9a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1V8z" />
              </svg>
              <span className="text-[10px] text-cyan-500 uppercase tracking-wider font-semibold">카메라 연결 현황</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: "전체", value: aggregate.total,    color: "text-ink2" },
                { label: "정상", value: aggregate.healthy,  color: "text-green-400" },
                { label: "경고", value: aggregate.degraded, color: "text-yellow-400" },
                { label: "다운", value: aggregate.down,     color: "text-red-400" },
              ].map(({ label, value, color }) => (
                <div key={label} className="text-center">
                  <p className={`text-2xl font-bold ${color}`}>{value}</p>
                  <p className="text-xs text-faint mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            {/* ── CPU / Memory 바 ── */}
            {showBars && (
              <div className="space-y-1.5 pt-1 border-t border-line">
                {cpuPct != null && (
                  <ResourceBar
                    label="CPU"
                    pct={cpuPct}
                    usage={cpuUsageLabel}
                    barColor={cpuPct >= 80 ? "bg-red-500" : cpuPct >= 60 ? "bg-yellow-500" : "bg-cyan-500"}
                    textColor={cpuPct >= 80 ? "text-red-400" : cpuPct >= 60 ? "text-yellow-400" : "text-cyan-400"}
                  />
                )}
                {memPct != null && (
                  <ResourceBar
                    label="Memory"
                    pct={memPct}
                    usage={memUsageLabel}
                    barColor={memPct >= 85 ? "bg-red-500" : memPct >= 70 ? "bg-amber-500" : "bg-amber-400"}
                    textColor={memPct >= 85 ? "text-red-400" : memPct >= 70 ? "text-amber-400" : "text-amber-300"}
                  />
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <p className="text-sm text-red-400">{error}</p>
            {customer.networkType !== "onprem" && (
              <button
                onClick={handleReconnect}
                disabled={reconnecting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan-50 border border-cyan-400 text-cyan-700 rounded-lg hover:bg-cyan-100 disabled:opacity-40 transition-colors dark:bg-cyan-900/40 dark:text-cyan-400 dark:border-cyan-800 dark:hover:bg-cyan-900/70"
              >
                {reconnecting ? (
                  <>
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    연결 확인 중...
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    재연결 시도
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </Link>
    </div>
  );
}
