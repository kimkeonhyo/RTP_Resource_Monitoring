"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Customer } from "@/lib/types";
import type {
  CentralMetricsResult, NodeMetric, GpuMetric,
} from "@/app/api/customers/[id]/metrics/route";

const REFRESH_INTERVAL = 30_000; // 30초 자동 갱신

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function fmtBps(bps?: number): string {
  if (bps === undefined) return "—";
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} GB/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

const fmtPct = (v?: number) => (v === undefined ? "—" : `${v.toFixed(1)}%`);

function Bar({ pct, color = "cyan" }: { pct: number; color?: "cyan" | "green" | "amber" }) {
  const map = { cyan: "bg-cyan-500", green: "bg-green-500", amber: "bg-amber-500" };
  const fill = pct > 85 ? "bg-red-500" : pct > 65 ? "bg-amber-500" : map[color];
  return (
    <div className="w-full h-1.5 bg-input rounded-full overflow-hidden">
      <div className={`h-full ${fill} rounded-full transition-all`}
           style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
    </div>
  );
}

function Metric({ label, value, pct, color, hint }: {
  label: string; value: string; pct?: number;
  color?: "cyan" | "green" | "amber"; hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline gap-2">
        <span className="text-[11px] text-faint font-medium">{label}</span>
        <span className="text-xs font-mono text-muted">{value}</span>
      </div>
      {pct !== undefined && <Bar pct={pct} color={color} />}
      {hint && <p className="text-[10px] text-faint">{hint}</p>}
    </div>
  );
}

// ── 서브 컴포넌트 ─────────────────────────────────────────────────────────────

function NodeCard({ n }: { n: NodeMetric }) {
  return (
    <div className="bg-panel border border-line2 rounded-xl p-4 space-y-3">
      <p className="text-sm font-semibold text-ink font-mono break-all">{n.instance}</p>
      <Metric label="CPU" value={fmtPct(n.cpuPct)} pct={n.cpuPct} color="cyan" />
      <Metric
        label="Memory" value={fmtPct(n.memPct)} pct={n.memPct} color="green"
        hint={n.memTotalGb ? `전체 ${n.memTotalGb.toFixed(1)} GB` : undefined}
      />
      <Metric label="Disk (/)" value={fmtPct(n.diskPct)} pct={n.diskPct} color="amber" />
      {n.load1 !== undefined && (
        <div className="flex justify-between text-[11px]">
          <span className="text-faint">Load 1m</span>
          <span className="font-mono text-muted">{n.load1.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}

function GpuCard({ g }: { g: GpuMetric }) {
  const hot = (g.tempC ?? 0) > 85;
  return (
    <div className={`bg-panel border rounded-xl p-4 space-y-3 ${hot ? "border-red-800/60" : "border-line2"}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">GPU {g.gpu}</p>
        {g.tempC !== undefined && (
          <span className={`text-xs font-mono ${hot ? "text-red-400" : g.tempC > 70 ? "text-amber-400" : "text-muted"}`}>
            {g.tempC.toFixed(0)}°C
          </span>
        )}
      </div>
      {g.hostname && <p className="text-[10px] text-faint font-mono break-all -mt-2">{g.hostname}</p>}
      <Metric label="사용률" value={fmtPct(g.utilPct)} pct={g.utilPct} color="cyan" />
      <div className="flex justify-between text-[11px]">
        <span className="text-faint">메모리</span>
        <span className="font-mono text-muted">
          {g.memUsedMib === undefined ? "—" : `${(g.memUsedMib / 1024).toFixed(1)} GB`}
        </span>
      </div>
      <div className="flex justify-between text-[11px]">
        <span className="text-faint">전력</span>
        <span className="font-mono text-muted">
          {g.powerW === undefined ? "—" : `${g.powerW.toFixed(0)} W`}
        </span>
      </div>
    </div>
  );
}

function StatTile({ label, value, tone = "normal", hint }: {
  label: string; value: string; tone?: "normal" | "good" | "bad"; hint?: string;
}) {
  const color = tone === "bad" ? "text-red-400" : tone === "good" ? "text-green-400" : "text-cyan-400";
  return (
    <div className="bg-panel border border-line rounded-xl px-4 py-3">
      <p className="text-[11px] text-faint font-medium">{label}</p>
      <p className={`text-2xl font-bold font-mono mt-1 ${color}`}>{value}</p>
      {hint && <p className="text-[10px] text-faint mt-0.5">{hint}</p>}
    </div>
  );
}

/** "N개 중 M개 정상" — 비율 막대까지 함께 */
function HealthRatio({ label, ok, total, hint }: {
  label: string; ok?: number; total?: number; hint?: string;
}) {
  const has = total !== undefined && total > 0 && ok !== undefined;
  const pct = has ? (ok / total) * 100 : 0;
  const tone = !has ? "text-faint" : pct === 100 ? "text-green-400"
    : pct >= 80 ? "text-amber-400" : "text-red-400";
  const barColor = !has ? "bg-line2" : pct === 100 ? "bg-green-500"
    : pct >= 80 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="bg-panel border border-line rounded-xl px-4 py-3 space-y-2">
      <p className="text-[11px] text-faint font-medium">{label}</p>
      <p className="font-mono">
        <span className={`text-2xl font-bold ${tone}`}>{has ? ok : "—"}</span>
        <span className="text-sm text-faint"> / {total ?? "—"}</span>
      </p>
      <div className="w-full h-1.5 bg-input rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all`}
             style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {hint && <p className="text-[10px] text-faint">{hint}</p>}
    </div>
  );
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

export default function CentralMetrics({ customer }: { customer: Customer }) {
  const [data, setData] = useState<CentralMetricsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/customers/${customer.id}/metrics`, { cache: "no-store" });
      if (!res.ok) throw new Error(`서버 오류: ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [customer.id]);

  useEffect(() => {
    fetchMetrics();
    timerRef.current = setInterval(fetchMetrics, REFRESH_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchMetrics]);

  const checkedAt = data?.checkedAt
    ? new Date(data.checkedAt).toLocaleTimeString("ko-KR", { hour12: false })
    : null;

  const down = data?.targets.down ?? 0;
  const s = data?.stream;
  const k = data?.k8s;

  return (
    <div className="space-y-6">

      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-3 px-1">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="flex items-center gap-2 text-[11px]">
            <span className="text-faint">중앙 메트릭</span>
            <span className="px-1.5 py-0.5 bg-cyan-900/30 text-cyan-500 border border-cyan-900 rounded font-mono">
              customer={customer.metricsLabel}
            </span>
          </span>
          {data && !data.noData && (
            <span className="flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${down > 0 ? "bg-red-500" : "bg-green-400 animate-pulse"}`} />
              <span className={down > 0 ? "text-red-400" : "text-green-400"}>
                타깃 {data.targets.total - down}/{data.targets.total} 정상
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {checkedAt && <span className="text-[11px] text-faint">마지막 체크: {checkedAt}</span>}
          {data?.grafanaUrl && (
            <a href={data.grafanaUrl} target="_blank" rel="noopener noreferrer"
               className="px-3 py-1.5 text-xs bg-input text-muted border border-line2 rounded-lg hover:bg-gray-700 hover:text-ink2">
              Grafana에서 자세히 ↗
            </a>
          )}
          <button onClick={fetchMetrics} disabled={loading}
                  className="px-3 py-1.5 text-xs bg-input text-muted border border-line2 rounded-lg hover:bg-gray-700 hover:text-ink2 disabled:opacity-40 flex items-center gap-1.5">
            <span className={loading ? "animate-spin" : ""}>↻</span>
            {loading ? "조회 중..." : "새로고침"}
          </button>
        </div>
      </div>

      {/* 에러 */}
      {(error || data?.error) && (
        <div className="px-4 py-3 bg-red-50 border border-red-300 rounded-xl text-xs text-red-600 dark:bg-red-950/30 dark:border-red-800/60 dark:text-red-400">
          ✕ {error ?? data?.error}
        </div>
      )}

      {/* 데이터 없음 — remote_write 미설정/중단 */}
      {data && data.reachable && data.noData && (
        <div className="px-4 py-6 text-center text-sm text-faint bg-panel border border-line rounded-xl">
          중앙 서버에 <span className="text-amber-500 font-mono">customer={data.label}</span> 데이터가 없습니다.
          <p className="text-xs mt-2">
            고객사 Prometheus 의 <span className="font-mono">external_labels</span> ·
            <span className="font-mono"> remote_write</span> 설정과 라벨 값이 일치하는지 확인하세요.
          </p>
        </div>
      )}

      {/* 로딩 (최초) */}
      {loading && !data && (
        <div className="py-12 text-center">
          <div className="inline-block w-6 h-6 border-2 border-line2 border-t-cyan-500 rounded-full animate-spin mb-3" />
          <p className="text-sm text-faint">중앙 메트릭 조회 중...</p>
        </div>
      )}

      {data && !data.noData && (
        <>
          {/* 요약 타일 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatTile label="수집 실패 타깃" value={String(down)}
                      tone={down > 0 ? "bad" : "good"}
                      hint="메트릭 스크랩 실패 (파드 상태와 별개)" />
            <StatTile label="Running 파드" value={data.k8s.runningPods?.toString() ?? "—"} />
            <StatTile label="Ready 노드" value={data.k8s.readyNodes?.toString() ?? "—"} />
            <StatTile label="수신 트래픽" value={fmtBps(s?.rxBps)}
                      hint={`송신 ${fmtBps(s?.txBps)}`} />
            <StatTile label="리더" value={`${s?.rtspReaders ?? "—"} / ${s?.webrtcReaders ?? "—"}`}
                      hint="RTSP / WebRTC" />
          </div>

          {/* 스트림 건강도 — 몇 개 중 몇 개가 정상인가 */}
          <div>
            <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
              스트림 건강도
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <HealthRatio label="카메라 경로 (수신 중)"
                           ok={s?.pathsActive} total={s?.paths}
                           hint="최근 5분간 데이터가 들어온 경로" />
              <HealthRatio label="RTSP 세션 (정상)"
                           ok={s?.rtspHealthy} total={s?.rtspSessions}
                           hint="패킷 유실률 5% 미만" />
              <HealthRatio label="WebRTC 세션 (정상)"
                           ok={s?.webrtcHealthy} total={s?.webrtcSessions}
                           hint="유실 패킷 0건" />
            </div>
          </div>

          {/* 다운 타깃 목록 */}
          {data.targets.downList.length > 0 && (
            <div className="bg-panel border border-red-800/60 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-2">
                스크랩 실패 타깃 ({data.targets.downList.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                {data.targets.downList.map((t) => (
                  <span key={`${t.job}-${t.instance}`}
                        className="text-[11px] font-mono px-2 py-1 bg-red-900/30 text-red-400 border border-red-900 rounded">
                    {t.job} <span className="text-faint">·</span> {t.instance}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 워크로드 상태 — 파드가 실제로 도는가.
              up 은 "메트릭 포트가 열렸나"만 보므로 여기서 따로 판단한다. */}
          <div className="bg-panel border border-line rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
                워크로드 상태
              </h3>
              <span className="text-[10px] text-faint">kube-state-metrics 기준</span>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-[11px] text-faint">기동 실패 컨테이너</p>
                <p className={`text-2xl font-bold font-mono mt-0.5 ${
                  (k?.problemPods?.length ?? 0) > 0 ? "text-red-400" : "text-green-400"}`}>
                  {k?.problemPods?.length ?? 0}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-faint">미가용 복제본</p>
                <p className={`text-2xl font-bold font-mono mt-0.5 ${
                  (k?.unavailableReplicas ?? 0) > 0 ? "text-amber-400" : "text-muted"}`}>
                  {k?.unavailableReplicas ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-faint">재시작 (15분)</p>
                <p className={`text-2xl font-bold font-mono mt-0.5 ${
                  (k?.recentRestarts ?? 0) > 0 ? "text-amber-400" : "text-muted"}`}>
                  {k?.recentRestarts !== undefined ? Math.round(k.recentRestarts) : "—"}
                </p>
              </div>
            </div>

            {(k?.problemPods?.length ?? 0) > 0 && (
              <div className="mt-4 pt-3 border-t border-line space-y-1.5">
                {k!.problemPods.map((p) => (
                  <div key={`${p.namespace}/${p.pod}`}
                       className="flex items-center gap-2 text-[11px]">
                    <span className="shrink-0 px-1.5 py-0.5 bg-red-900/30 text-red-400 border border-red-900 rounded font-mono">
                      {p.reason}
                    </span>
                    <span className="text-faint font-mono shrink-0">{p.namespace}</span>
                    <span className="text-muted font-mono truncate">{p.pod}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* RTP 유실률 — 영상 끊김 지표 */}
          {s?.maxLossRatio !== undefined && (
            <div className="bg-panel border border-line rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
                  RTP 패킷 유실률 (최대)
                </h3>
                <span className={`text-sm font-mono ${
                  s.maxLossRatio > 0.15 ? "text-red-400" :
                  s.maxLossRatio > 0.05 ? "text-amber-400" : "text-green-400"
                }`}>
                  {(s.maxLossRatio * 100).toFixed(2)}%
                </span>
              </div>
              <Bar pct={s.maxLossRatio * 100 * 6.67 /* 15% 를 100% 로 스케일 */} color="green" />
              <p className="text-[10px] text-faint mt-1.5">
                5% 초과 시 네트워크 품질 저하, 15% 초과 시 영상 끊김이 심각합니다.
              </p>
            </div>
          )}

          {/* WebRTC 품질 — 브라우저로 나가는 구간 */}
          {(s?.webrtcSessions ?? 0) > 0 && (
            <div className="bg-panel border border-line rounded-xl p-4">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">
                WebRTC 품질
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <p className="text-[11px] text-faint">최대 지터</p>
                  <p className={`text-lg font-mono mt-0.5 ${
                    (s?.webrtcMaxJitter ?? 0) > 0.05 ? "text-amber-400" : "text-muted"}`}>
                    {s?.webrtcMaxJitter === undefined ? "—" : `${(s.webrtcMaxJitter * 1000).toFixed(1)} ms`}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-faint">유실 패킷 (누적)</p>
                  <p className={`text-lg font-mono mt-0.5 ${
                    (s?.webrtcLost ?? 0) > 0 ? "text-amber-400" : "text-muted"}`}>
                    {s?.webrtcLost?.toLocaleString() ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-faint">폐기 프레임 (누적)</p>
                  <p className={`text-lg font-mono mt-0.5 ${
                    (s?.webrtcFramesDiscarded ?? 0) > 0 ? "text-amber-400" : "text-muted"}`}>
                    {s?.webrtcFramesDiscarded?.toLocaleString() ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-faint">연결 / 해제 (초당)</p>
                  <p className="text-lg font-mono mt-0.5 text-muted">
                    {(s?.webrtcConnectRate ?? 0).toFixed(2)}
                    <span className="text-faint"> / </span>
                    <span className={
                      (s?.webrtcDisconnectRate ?? 0) > (s?.webrtcConnectRate ?? 0)
                        ? "text-amber-400" : ""}>
                      {(s?.webrtcDisconnectRate ?? 0).toFixed(2)}
                    </span>
                  </p>
                </div>
              </div>
              <p className="text-[10px] text-faint mt-3">
                해제가 연결보다 지속적으로 많으면 세션이 자꾸 끊기는 중입니다.
              </p>
            </div>
          )}

          {/* 경로별 수신 트래픽 — 어떤 카메라가 얼마나 들어오는지 */}
          {(s?.topPaths?.length ?? 0) > 0 && (
            <div className="bg-panel border border-line rounded-xl p-4">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">
                경로별 수신 트래픽 (상위 {s!.topPaths!.length})
              </h3>
              <div className="space-y-2">
                {(() => {
                  const max = Math.max(...s!.topPaths!.map((p) => p.rxBps), 1);
                  return s!.topPaths!.map((p) => (
                    <div key={p.path} className="flex items-center gap-3">
                      <span className="text-[11px] font-mono text-muted w-44 shrink-0 truncate"
                            title={p.path}>{p.path}</span>
                      <div className="flex-1 h-1.5 bg-input rounded-full overflow-hidden">
                        <div className="h-full bg-cyan-500 rounded-full"
                             style={{ width: `${(p.rxBps / max) * 100}%` }} />
                      </div>
                      <span className="text-[11px] font-mono text-faint w-20 text-right shrink-0">
                        {fmtBps(p.rxBps)}
                      </span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}

          {/* 노드 */}
          {data.nodes.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
                노드 ({data.nodes.length})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.nodes.map((n) => <NodeCard key={n.instance} n={n} />)}
              </div>
            </div>
          )}

          {/* GPU */}
          {data.gpus.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
                GPU ({data.gpus.length})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {data.gpus.map((g) => <GpuCard key={`${g.hostname}-${g.gpu}`} g={g} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
