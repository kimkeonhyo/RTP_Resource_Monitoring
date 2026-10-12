"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Customer } from "@/lib/types";
import type { K8sStatusResult, K8sNode, NetIface } from "@/app/api/customers/[id]/k8s-status/route";

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function fmtBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9)  return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6)  return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3)  return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function Bar({ pct, color = "cyan" }: { pct: number; color?: "cyan" | "green" | "amber" | "red" }) {
  const colorMap = {
    cyan:  "bg-cyan-500",
    green: "bg-green-500",
    amber: "bg-amber-500",
    red:   "bg-red-500",
  };
  const fill = colorMap[pct > 85 ? "red" : pct > 65 ? "amber" : color];
  return (
    <div className="w-full h-1.5 bg-input rounded-full overflow-hidden">
      <div className={`h-full ${fill} rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

// ── 서브 컴포넌트 ─────────────────────────────────────────────────────────────

function ApiHealthBadge({ status, ms }: { status: K8sStatusResult["apiHealth"]; ms?: number }) {
  if (status === "skipped") return <span className="text-faint text-xs">VIP 미설정</span>;
  const map = {
    ok:          { dot: "bg-green-400", label: "API 정상",      text: "text-green-400" },
    error:       { dot: "bg-amber-400", label: "API 이상",      text: "text-amber-400" },
    unreachable: { dot: "bg-red-500",   label: "API 응답 없음", text: "text-red-400"   },
  } as const;
  const { dot, label, text } = map[status];
  return (
    <span className={`flex items-center gap-1.5 text-xs ${text}`}>
      <span className={`w-2 h-2 rounded-full ${dot} animate-${status === "ok" ? "pulse" : "none"}`} />
      {label}
      {ms !== undefined && status === "ok" && <span className="text-faint">({ms}ms)</span>}
    </span>
  );
}

function NodeCard({ node }: { node: K8sNode }) {
  const isReady = node.status === "Ready";
  return (
    <div className={`bg-panel border rounded-xl p-4 space-y-3 ${
      isReady ? "border-line2" : "border-red-800/60"
    }`}>
      {/* 이름 + 상태 */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink font-mono break-all">{node.name}</p>
          <p className="text-[11px] text-faint mt-0.5">{node.internalIp}</p>
        </div>
        <span className={`shrink-0 flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${
          isReady
            ? "bg-green-100 text-green-700 border border-green-400 dark:bg-green-900/40 dark:text-green-400 dark:border-green-800"
            : "bg-red-100 text-red-700 border border-red-400 dark:bg-red-900/40 dark:text-red-400 dark:border-red-800"
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${isReady ? "bg-green-400" : "bg-red-500"}`} />
          {node.status}
        </span>
      </div>

      {/* 역할 + 버전 + 가동 기간 */}
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {node.roles.split(", ").map((r) => (
          <span key={r} className="px-1.5 py-0.5 bg-cyan-900/30 text-cyan-500 border border-cyan-900 rounded">
            {r}
          </span>
        ))}
        <span className="px-1.5 py-0.5 bg-input text-faint rounded">{node.version}</span>
        <span className="px-1.5 py-0.5 bg-input text-faint rounded">↑{node.age}</span>
      </div>

      {/* CPU 사용률 */}
      {node.cpuPct !== undefined ? (
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-faint">
            <span>CPU</span>
            <span className="font-mono">{node.cpuUsage} <span className="text-faint">({node.cpuPct}%)</span></span>
          </div>
          <Bar pct={node.cpuPct} color="cyan" />
        </div>
      ) : (
        <div className="text-[11px] text-faint italic">CPU 지표 없음 (metrics-server 필요)</div>
      )}

      {/* Memory 사용률 */}
      {node.memPct !== undefined ? (
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-faint">
            <span>Memory</span>
            <span className="font-mono">{node.memUsage} <span className="text-faint">({node.memPct}%)</span></span>
          </div>
          <Bar pct={node.memPct} color="green" />
        </div>
      ) : null}
    </div>
  );
}

function SystemPanel({
  data,
  ip,
}: {
  data: K8sStatusResult;
  ip?: string;
}) {
  const mem = data.systemMemory;
  const cpu = data.systemCpu;
  const disk = data.systemDisk;

  const memPct = mem ? Math.round((mem.usedMb / mem.totalMb) * 100) : undefined;
  const loadPct = cpu ? Math.min(Math.round((cpu.load1 / cpu.cores) * 100), 100) : undefined;
  const diskPct = disk ? parseInt(disk.usePct) : undefined;

  // 주요 네트워크 인터페이스만 표시 (tailscale, eth, ens, bond 등)
  const netIfaces = (data.systemNetwork ?? []).filter((n: NetIface) =>
    /^(eth|ens|eno|bond|tailscale|wlan|flannel|cali|tunl)/.test(n.name)
  );

  return (
    <div className="bg-panel border border-line rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
          시스템 메트릭
        </h3>
        {ip && <span className="text-[11px] text-faint font-mono">하드웨어 IP: {ip}</span>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Load Average */}
        {cpu && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <p className="text-[11px] text-faint font-medium">CPU Load Average</p>
              <span className="text-[10px] text-faint opacity-60">({cpu.cores} cores)</span>
            </div>
            <p className="text-[10px] text-faint opacity-50 -mt-1 leading-relaxed">
              CPU + I/O 대기 프로세스 수 평균. 코어 수보다 낮으면 여유 있음.
            </p>
            <div className="space-y-1">
              {[["1m", cpu.load1], ["5m", cpu.load5], ["15m", cpu.load15]].map(([label, val]) => {
                const pct = Math.round(((val as number) / cpu.cores) * 100);
                return (
                  <div key={label as string} className="flex justify-between items-center gap-2">
                    <span className="text-[10px] text-faint w-6">{label}</span>
                    <div className="flex-1">
                      <Bar pct={pct} color="cyan" />
                    </div>
                    <span className={`text-[11px] font-mono w-12 text-right ${
                      pct > 100 ? "text-red-400" : pct > 80 ? "text-amber-400" : "text-muted"
                    }`}>
                      {(val as number).toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </div>
            {loadPct !== undefined && (
              <p className="text-[10px] text-faint">1m 기준 {loadPct}% 부하</p>
            )}
          </div>
        )}

        {/* Memory */}
        {mem && memPct !== undefined && (
          <div className="space-y-2">
            <p className="text-[11px] text-faint font-medium">Memory</p>
            <Bar pct={memPct} color="green" />
            <div className="flex justify-between text-[11px] font-mono">
              <span className="text-muted">{fmtMb(mem.usedMb)} 사용</span>
              <span className="text-faint">/ {fmtMb(mem.totalMb)}</span>
            </div>
            <p className="text-[10px] text-faint">가용: {fmtMb(mem.availMb)}</p>
          </div>
        )}

        {/* Disk */}
        {disk && diskPct !== undefined && (
          <div className="space-y-2">
            <p className="text-[11px] text-faint font-medium">Disk (/)</p>
            <Bar pct={diskPct} color="amber" />
            <div className="flex justify-between text-[11px] font-mono">
              <span className="text-muted">{disk.used} 사용</span>
              <span className="text-faint">/ {disk.size}</span>
            </div>
            <p className="text-[10px] text-faint">가용: {disk.avail}</p>
          </div>
        )}

        {/* Kubelet + Pods */}
        <div className="space-y-3">
          <div>
            <p className="text-[11px] text-faint font-medium mb-1">Kubelet</p>
            {data.kubeletStatus === "active" ? (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <span className="w-2 h-2 rounded-full bg-green-400" /> active
              </span>
            ) : data.kubeletStatus === "inactive" ? (
              <span className="flex items-center gap-1 text-xs text-red-400">
                <span className="w-2 h-2 rounded-full bg-red-500" /> inactive
              </span>
            ) : (
              <span className="text-xs text-faint">unknown</span>
            )}
          </div>
          {data.podCount !== undefined && (
            <div>
              <p className="text-[11px] text-faint font-medium mb-1">전체 파드</p>
              <p className="text-2xl font-bold text-cyan-400 font-mono">{data.podCount}</p>
            </div>
          )}
        </div>
      </div>

      {/* 네트워크 인터페이스 */}
      {netIfaces.length > 0 && (
        <div>
          <p className="text-[11px] text-faint font-medium mb-2">네트워크 누적 트래픽 (부팅 이후)</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-faint">
                  <th className="text-left py-1.5 pr-6 font-medium">인터페이스</th>
                  <th className="text-right py-1.5 pr-6 font-medium">↓ 수신 (RX)</th>
                  <th className="text-right py-1.5 font-medium">↑ 송신 (TX)</th>
                </tr>
              </thead>
              <tbody>
                {netIfaces.map((iface: NetIface) => (
                  <tr key={iface.name} className="border-b border-line/40">
                    <td className="py-1.5 pr-6 font-mono text-muted">{iface.name}</td>
                    <td className="py-1.5 pr-6 text-right font-mono text-cyan-600">
                      {fmtBytes(iface.rxBytes)}
                    </td>
                    <td className="py-1.5 text-right font-mono text-amber-600">
                      {fmtBytes(iface.txBytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 30_000; // 30초 자동 갱신

export default function StatusWatch({ customer }: { customer: Customer }) {
  const [data, setData]     = useState<K8sStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/customers/${customer.id}/k8s-status`, { cache: "no-store" });
      if (!res.ok) throw new Error(`서버 오류: ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [customer.id]);

  useEffect(() => {
    fetchStatus();
    timerRef.current = setInterval(fetchStatus, REFRESH_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchStatus]);

  const checkedAt = data?.checkedAt
    ? new Date(data.checkedAt).toLocaleTimeString("ko-KR", { hour12: false })
    : null;

  // ── 렌더 ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* 헤더 바 */}
      <div className="flex items-center justify-between flex-wrap gap-3 px-1">
        <div className="flex items-center gap-4 flex-wrap">
          {/* K8s API */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-faint">K8s API</span>
            {data ? (
              <ApiHealthBadge status={data.apiHealth} ms={data.apiResponseMs} />
            ) : (
              <span className="text-[11px] text-faint">—</span>
            )}
            {customer.vip && (
              <span className="text-[10px] text-faint font-mono">({customer.vip})</span>
            )}
          </div>

          {/* SSH */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-faint">SSH</span>
            {data ? (
              <span className={`flex items-center gap-1 text-xs ${data.sshReachable ? "text-green-400" : "text-red-400"}`}>
                <span className={`w-2 h-2 rounded-full ${data.sshReachable ? "bg-green-400" : "bg-red-500"}`} />
                {data.sshReachable ? "연결됨" : "연결 실패"}
              </span>
            ) : (
              <span className="text-[11px] text-faint">—</span>
            )}
            {customer.ip && (
              <span className="text-[10px] text-faint font-mono">({customer.ip})</span>
            )}
          </div>

          {/* 노드 요약 */}
          {data && data.nodes.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-faint">노드</span>
              <span className="text-green-400 font-mono">
                {data.nodes.filter((n) => n.status === "Ready").length}
              </span>
              <span className="text-faint">/</span>
              <span className="text-muted font-mono">{data.nodes.length}</span>
              <span className="text-faint">Ready</span>
            </div>
          )}
        </div>

        {/* 새로고침 */}
        <div className="flex items-center gap-3">
          {checkedAt && (
            <span className="text-[11px] text-faint">마지막 체크: {checkedAt}</span>
          )}
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="px-3 py-1.5 text-xs bg-input text-muted border border-line2 rounded-lg hover:bg-gray-700 hover:text-ink2 disabled:opacity-40 flex items-center gap-1.5"
          >
            <span className={loading ? "animate-spin" : ""}>↻</span>
            {loading ? "조회 중..." : "새로고침"}
          </button>
        </div>
      </div>

      {/* 에러 */}
      {error && (
        <div className="px-4 py-3 bg-red-50 border border-red-300 rounded-xl text-xs text-red-600 dark:bg-red-950/30 dark:border-red-800/60 dark:text-red-400">
          ✕ {error}
        </div>
      )}

      {/* SSH 오류 메시지 */}
      {data?.error && !data.sshReachable && (
        <div className="px-4 py-3 bg-red-50 border border-red-300 rounded-xl text-xs text-red-600 dark:bg-red-950/30 dark:border-red-800/60 dark:text-red-400 flex items-start justify-between gap-3">
          <span>✕ SSH: {data.error}</span>
          {data.error.includes("비밀번호") && (
            <a
              href={`/customers/${customer.id}/edit`}
              className="shrink-0 px-2 py-1 bg-red-100 border border-red-400 rounded text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900 whitespace-nowrap"
            >
              ✎ 고객사 수정
            </a>
          )}
        </div>
      )}

      {/* 설정 안내 */}
      {!customer.ip && !customer.vip && !loading && (
        <div className="px-4 py-6 text-center text-sm text-faint">
          고객사 설정에서 <span className="text-amber-500">하드웨어 IP</span> 또는{" "}
          <span className="text-amber-500">VIP</span>를 설정하면 K8s 상태를 조회할 수 있습니다.
        </div>
      )}

      {/* 로딩 (최초) */}
      {loading && !data && (
        <div className="py-12 text-center">
          <div className="inline-block w-6 h-6 border-2 border-line2 border-t-cyan-500 rounded-full animate-spin mb-3" />
          <p className="text-sm text-faint">K8s 상태 조회 중...</p>
          <p className="text-xs text-faint mt-1">SSH 연결 + kubectl 실행 (최대 30초)</p>
        </div>
      )}

      {/* 노드 카드 그리드 */}
      {data && data.nodes.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
            K8s Nodes ({data.nodes.length})
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {data.nodes.map((node) => (
              <NodeCard key={node.name} node={node} />
            ))}
          </div>
        </div>
      )}

      {/* kubectl 사용 불가 안내 */}
      {data?.sshReachable && data.nodes.length === 0 && (
        <div className="px-4 py-3 bg-panel border border-line rounded-xl text-xs text-faint">
          ℹ kubectl 명령을 찾을 수 없거나 노드 정보가 없습니다.
          SSH 사용자에게 kubectl 실행 권한이 있는지 확인하세요.
        </div>
      )}

      {/* 시스템 메트릭 패널 */}
      {data?.sshReachable && (
        <SystemPanel data={data} ip={customer.ip} />
      )}
    </div>
  );
}
