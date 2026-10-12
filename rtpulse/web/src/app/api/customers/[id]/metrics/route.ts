/**
 * GET /api/customers/{id}/metrics
 *
 * 중앙 메트릭 서버(VictoriaMetrics)에서 해당 고객사의 현재 상태를 조회합니다.
 *
 * 데이터 흐름:
 *   고객사 Prometheus --remote_write--> VictoriaMetrics(중앙) <--PromQL-- 이 라우트
 *
 * customer.metricsLabel 이 고객사 Prometheus 의 external_labels.customer 값과
 * 일치해야 합니다. 값이 없으면 404 를 반환하고, UI 는 기존 SSH 방식으로 폴백합니다.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const VM_URL      = process.env.CENTRAL_METRICS_URL ?? "http://192.0.2.35:8428"; // example
const GRAFANA_URL = process.env.CENTRAL_GRAFANA_URL ?? "http://192.0.2.35:3000"; // example

// ── 타입 ────────────────────────────────────────────────────────────────────

export interface NodeMetric {
  instance: string;
  cpuPct?: number;
  memPct?: number;
  memTotalGb?: number;
  diskPct?: number;
  load1?: number;
}

export interface GpuMetric {
  gpu: string;
  hostname?: string;
  utilPct?: number;
  memUsedMib?: number;
  tempC?: number;
  powerW?: number;
}

export interface DownTarget {
  job: string;
  instance: string;
}

export interface CentralMetricsResult {
  label: string;
  /** 중앙 Grafana 대시보드 딥링크 (고객사 필터 적용) */
  grafanaUrl: string;
  checkedAt: string;
  reachable: boolean;
  /** 이 고객사 시계열이 중앙에 하나도 없을 때 (remote_write 미설정/중단) */
  noData: boolean;
  targets: { total: number; down: number; downList: DownTarget[] };
  nodes: NodeMetric[];
  gpus: GpuMetric[];
  stream: {
    // 경로(카메라) — 전체 중 실제로 수신 중인 개수
    paths?: number;
    pathsActive?: number;
    // 세션 — 전체 중 정상 개수 (RTSP: 유실률 5% 미만 / WebRTC: 유실 패킷 0)
    rtspSessions?: number;
    rtspHealthy?: number;
    webrtcSessions?: number;
    webrtcHealthy?: number;
    rtspReaders?: number;
    webrtcReaders?: number;
    rxBps?: number;
    txBps?: number;
    maxLossRatio?: number;
    // WebRTC 품질
    webrtcMaxJitter?: number;
    webrtcLost?: number;
    webrtcFramesDiscarded?: number;
    webrtcConnectRate?: number;
    webrtcDisconnectRate?: number;
    /** 경로별 수신 트래픽 상위 — 어떤 카메라가 얼마나 들어오는지 */
    topPaths?: { path: string; rxBps: number }[];
  };
  k8s: {
    runningPods?: number;
    readyNodes?: number;
    /** Deployment 미가용 복제본 합 */
    unavailableReplicas?: number;
    /** 최근 15분 컨테이너 재시작 횟수 */
    recentRestarts?: number;
    /**
     * 기동하지 못하는 컨테이너 (CrashLoopBackOff · ImagePullBackOff 등).
     * up 은 "메트릭 포트가 열렸나"만 보므로 워크로드 건강은 이쪽으로 판단한다.
     */
    problemPods: { namespace: string; pod: string; reason: string }[];
  };
  error?: string;
}

// ── VictoriaMetrics 조회 ─────────────────────────────────────────────────────

interface VmSample {
  metric: Record<string, string>;
  value: [number, string];
}

async function promQuery(expr: string, timeoutMs = 8_000): Promise<VmSample[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${VM_URL}/api/v1/query?query=${encodeURIComponent(expr)}`,
      { signal: ctl.signal, cache: "no-store" }
    );
    if (!res.ok) throw new Error(`VictoriaMetrics HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.error ?? "query failed");
    return (json.data?.result ?? []) as VmSample[];
  } finally {
    clearTimeout(timer);
  }
}

/** 스칼라 1개만 필요한 쿼리 — 결과 없으면 undefined */
async function scalar(expr: string): Promise<number | undefined> {
  const r = await promQuery(expr);
  const v = r[0]?.value?.[1];
  return v === undefined ? undefined : Number(v);
}

const num = (s: VmSample) => Number(s.value[1]);

// ── 핸들러 ───────────────────────────────────────────────────────────────────

export async function GET(_: NextRequest, { params }: Params) {
  const { id } = await params;
  const customer = await getCustomer(id);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const label = customer.metricsLabel?.trim();
  if (!label) {
    return NextResponse.json(
      { error: "metricsLabel 미설정" },
      { status: 404 }
    );
  }

  // PromQL 인젝션 방지 — 라벨 값은 영숫자/하이픈/언더스코어만 허용.
  // (사용자 입력이 그대로 쿼리 문자열에 들어가는 신뢰 경계)
  if (!/^[A-Za-z0-9_-]+$/.test(label)) {
    return NextResponse.json(
      { error: "metricsLabel 형식이 올바르지 않습니다 (영숫자·하이픈·언더스코어만)" },
      { status: 400 }
    );
  }

  const C = `customer="${label}"`;
  const result: CentralMetricsResult = {
    label,
    grafanaUrl: `${GRAFANA_URL}/d/vms-central/?var-customer=${encodeURIComponent(label)}`,
    checkedAt: new Date().toISOString(),
    reachable: false,
    noData: true,
    targets: { total: 0, down: 0, downList: [] },
    nodes: [],
    gpus: [],
    stream: {},
    k8s: { problemPods: [] },
  };

  try {
    const [
      up, cpu, mem, memTotal, disk, load1,
      gpuUtil, gpuMem, gpuTemp, gpuPower,
      paths, rtsp, webrtc, rx, tx, loss,
      pods, readyNodes,
      pathsActive, rtspSessions, rtspHealthy, webrtcSessions, webrtcHealthy,
      wrtcJitter, wrtcLost, wrtcDiscarded, wrtcConnect, wrtcDisconnect,
      topPaths,
      unavailReplicas, recentRestarts, waitingReasons,
    ] = await Promise.all([
      promQuery(`up{${C}}`),
      promQuery(`100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle",${C}}[5m])) * 100)`),
      promQuery(`(1 - node_memory_MemAvailable_bytes{${C}} / node_memory_MemTotal_bytes{${C}}) * 100`),
      promQuery(`node_memory_MemTotal_bytes{${C}}`),
      promQuery(`100 - (node_filesystem_avail_bytes{mountpoint="/",${C}} / node_filesystem_size_bytes{mountpoint="/",${C}} * 100)`),
      promQuery(`node_load1{${C}}`),
      promQuery(`DCGM_FI_DEV_GPU_UTIL{${C}}`),
      promQuery(`DCGM_FI_DEV_FB_USED{${C}}`),
      promQuery(`DCGM_FI_DEV_GPU_TEMP{${C}}`),
      promQuery(`DCGM_FI_DEV_POWER_USAGE{${C}}`),
      scalar(`count(count by(path)(mediamtx_path_bytes_received{${C}}))`),
      scalar(`sum(mediamtx_path_readers_by_type{reader_type="rtsp",${C}})`),
      scalar(`sum(mediamtx_path_readers_by_type{reader_type="webrtc",${C}})`),
      scalar(`sum(rate(mediamtx_path_bytes_received{${C}}[5m]))`),
      scalar(`sum(rate(mediamtx_path_bytes_sent{${C}}[5m]))`),
      scalar(`max(mediamtx_session_packet_loss_ratio_by_type{session_type="rtsp",${C}})`),
      scalar(`sum(kube_pod_status_phase{phase="Running",${C}})`),
      scalar(`sum(kube_node_status_condition{condition="Ready",status="true",${C}})`),
      // 스트림 건강도 — 전체 대비 정상 개수
      scalar(`count(count by(path)(rate(mediamtx_path_bytes_received{${C}}[5m]) > 0))`),
      scalar(`count(mediamtx_session_packet_loss_ratio_by_type{session_type="rtsp",${C}})`),
      scalar(`count(mediamtx_session_packet_loss_ratio_by_type{session_type="rtsp",${C}} < 0.05)`),
      scalar(`count(webrtc_sessions{${C}})`),
      scalar(`count(webrtc_sessions_rtp_packets_lost{${C}} == 0)`),
      // WebRTC 품질
      scalar(`max(webrtc_sessions_rtp_packets_jitter{${C}})`),
      scalar(`sum(webrtc_sessions_rtp_packets_lost{${C}})`),
      scalar(`sum(webrtc_sessions_outbound_frames_discarded{${C}})`),
      scalar(`sum(rate(mediamtx_webrtc_connects_total{${C}}[5m]))`),
      scalar(`sum(rate(mediamtx_webrtc_disconnects_total{${C}}[5m]))`),
      // 경로별 수신 트래픽 상위
      promQuery(`topk(8, sum by(path)(rate(mediamtx_path_bytes_received{${C}}[5m])))`),
      // 워크로드 건강 — kube-state-metrics
      scalar(`sum(kube_deployment_status_replicas_unavailable{${C}})`),
      scalar(`sum(increase(kube_pod_container_status_restarts_total{${C}}[15m]))`),
      promQuery(`kube_pod_container_status_waiting_reason{${C}} > 0`),
    ]);

    result.reachable = true;
    result.noData = up.length === 0;

    // 타깃 상태
    result.targets = {
      total: up.length,
      down: up.filter((s) => num(s) === 0).length,
      downList: up
        .filter((s) => num(s) === 0)
        .map((s) => ({
          job: s.metric.job ?? "-",
          instance: s.metric.instance ?? "-",
        })),
    };

    // 노드 — instance 기준으로 병합 (멀티노드 사이트 대응)
    const byInstance = new Map<string, NodeMetric>();
    const put = (inst: string, patch: Partial<NodeMetric>) => {
      const cur = byInstance.get(inst) ?? { instance: inst };
      byInstance.set(inst, { ...cur, ...patch });
    };
    cpu.forEach((s) => put(s.metric.instance, { cpuPct: num(s) }));
    mem.forEach((s) => put(s.metric.instance, { memPct: num(s) }));
    memTotal.forEach((s) => put(s.metric.instance, { memTotalGb: num(s) / 1024 ** 3 }));
    disk.forEach((s) => put(s.metric.instance, { diskPct: num(s) }));
    load1.forEach((s) => put(s.metric.instance, { load1: num(s) }));
    result.nodes = [...byInstance.values()].sort((a, b) =>
      a.instance.localeCompare(b.instance)
    );

    // GPU — gpu 라벨 기준 병합
    const byGpu = new Map<string, GpuMetric>();
    const putGpu = (s: VmSample, patch: Partial<GpuMetric>) => {
      const key = `${s.metric.Hostname ?? ""}/${s.metric.gpu ?? "0"}`;
      const cur = byGpu.get(key) ?? {
        gpu: s.metric.gpu ?? "0",
        hostname: s.metric.Hostname,
      };
      byGpu.set(key, { ...cur, ...patch });
    };
    gpuUtil.forEach((s) => putGpu(s, { utilPct: num(s) }));
    gpuMem.forEach((s) => putGpu(s, { memUsedMib: num(s) }));
    gpuTemp.forEach((s) => putGpu(s, { tempC: num(s) }));
    gpuPower.forEach((s) => putGpu(s, { powerW: num(s) }));
    result.gpus = [...byGpu.values()].sort((a, b) => a.gpu.localeCompare(b.gpu));

    result.stream = {
      paths, pathsActive,
      rtspSessions, rtspHealthy, webrtcSessions, webrtcHealthy,
      rtspReaders: rtsp, webrtcReaders: webrtc,
      rxBps: rx, txBps: tx, maxLossRatio: loss,
      webrtcMaxJitter: wrtcJitter,
      webrtcLost: wrtcLost,
      webrtcFramesDiscarded: wrtcDiscarded,
      webrtcConnectRate: wrtcConnect,
      webrtcDisconnectRate: wrtcDisconnect,
      topPaths: topPaths
        .map((s) => ({ path: s.metric.path ?? "-", rxBps: num(s) }))
        .sort((a, b) => b.rxBps - a.rxBps),
    };
    result.k8s = {
      runningPods: pods,
      readyNodes,
      unavailableReplicas: unavailReplicas,
      recentRestarts,
      problemPods: waitingReasons.map((x) => ({
        namespace: x.metric.namespace ?? "-",
        pod: x.metric.pod ?? "-",
        reason: x.metric.reason ?? "-",
      })),
    };
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json(result);
}
