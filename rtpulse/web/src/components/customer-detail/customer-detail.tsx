"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import useSWR from "swr";
import { Customer, ApiStream, ApiAggregate, ApiStats, ApiInfo, StreamHealth } from "@/lib/types";
import DashboardSection from "./dashboard-section";
import OverviewSection from "./overview-section";
import DetailSection from "./detail-section";
import LogsSection from "./logs-section";
import StatsSection from "./stats-section";
import CameraRegisterModal from "@/components/camera/camera-register-modal";
import CamerasSection from "./cameras-section";
import DataWatch from "@/components/data-watch/data-watch";
import StatusWatch from "./status-watch";
import CentralMetrics from "./central-metrics";

// 응답이 실패(예: rtpulse 미도달 시 프록시 502 + {error})면 throw 하여 SWR error로
// 처리한다. 그렇지 않으면 {error} 객체가 data로 흘러들어 배열을 기대하는 코드가
// "not iterable"로 크래시한다.
const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`요청 실패 (${r.status})`);
  return r.json();
};

type Tab = "stream" | "data" | "status";

// ── DB 카메라 타입 (cameras 테이블) ───────────────────────────────────────────

interface DbCamera {
  id: string;
  name: string;
  mainstream_url: string;
  substream_url: string;
  location?: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── 헬퍼: DB 카메라 + rtpulse 지표 → ApiStream[] ────────────────────────────

function buildDbStreams(cameras: DbCamera[], rtStreams: ApiStream[]): ApiStream[] {
  // 방어적: 에러 응답 등으로 배열이 아닐 수 있으므로 반드시 배열만 순회한다.
  const rt = Array.isArray(rtStreams) ? rtStreams : [];
  const cams = Array.isArray(cameras) ? cameras : [];
  const metricsByUrl = new Map<string, ApiStream>();
  for (const s of rt) metricsByUrl.set(s.url, s);

  const result: ApiStream[] = [];
  let syntheticId = 1;

  for (const cam of cams) {
    if (!cam.enabled) continue;

    // Mainstream
    const main = metricsByUrl.get(cam.mainstream_url);
    const mainProto = cam.mainstream_url.startsWith("rtsp://") ? "RTSP" : "RTP";
    result.push({
      id: syntheticId++,
      name: `${cam.name} (메인)`,
      url: cam.mainstream_url,
      protocol: mainProto,
      health: (main?.health ?? "UNKNOWN") as StreamHealth,
      bitrate_kbps: main?.bitrate_kbps ?? 0,
      packet_loss_pct: main?.packet_loss_pct ?? 0,
      jitter_ms: main?.jitter_ms ?? 0,
      fps: main?.fps ?? 0,
      uptime_secs: main?.uptime_secs ?? 0,
      last_update: main?.last_update ?? 0,
    });

    // Substream (있을 경우만)
    if (cam.substream_url) {
      const sub = metricsByUrl.get(cam.substream_url);
      const subProto = cam.substream_url.startsWith("rtsp://") ? "RTSP" : "RTP";
      result.push({
        id: syntheticId++,
        name: `${cam.name} (서브)`,
        url: cam.substream_url,
        protocol: subProto,
        health: (sub?.health ?? "UNKNOWN") as StreamHealth,
        bitrate_kbps: sub?.bitrate_kbps ?? 0,
        packet_loss_pct: sub?.packet_loss_pct ?? 0,
        jitter_ms: sub?.jitter_ms ?? 0,
        fps: sub?.fps ?? 0,
        uptime_secs: sub?.uptime_secs ?? 0,
        last_update: sub?.last_update ?? 0,
      });
    }
  }

  return result;
}

// ── 헬퍼: ApiStream[] → ApiAggregate ────────────────────────────────────────

function computeAggregate(streams: ApiStream[]): ApiAggregate {
  let healthy = 0, degraded = 0, down = 0, unknown = 0;
  let totalBitrate = 0, totalLoss = 0, totalJitter = 0;

  for (const s of streams) {
    if (s.health === "HEALTHY") healthy++;
    else if (s.health === "DEGRADED") degraded++;
    else if (s.health === "DOWN") down++;
    else unknown++;
    totalBitrate += s.bitrate_kbps;
    totalLoss += s.packet_loss_pct;
    totalJitter += s.jitter_ms;
  }

  const total = streams.length;
  return {
    total,
    healthy,
    degraded,
    down,
    unknown,
    total_bitrate_kbps: totalBitrate,
    avg_loss_pct: total ? totalLoss / total : 0,
    avg_jitter_ms: total ? totalJitter / total : 0,
  };
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function CustomerDetail({ customer }: { customer: Customer }) {
  const [tab, setTab] = useState<Tab>("stream");
  const [showCameraModal, setShowCameraModal] = useState(false);
  const [cameraAddedCount, setCameraAddedCount] = useState(0);
  const [cameraRefreshKey, setCameraRefreshKey] = useState(0);
  const base = `/api/proxy/${customer.id}`;

  // ── rtpulse 데이터 (Detail / Logs / Stats 섹션 + 지표 오버레이용) ─────────
  const { data: info, error: infoError } = useSWR<ApiInfo>(`${base}/api/info`, fetcher, { refreshInterval: 5000 });
  const { data: rtStreams } = useSWR<ApiStream[]>(`${base}/api/streams`, fetcher, { refreshInterval: 5000 });
  const { data: stats } = useSWR<ApiStats>(`${base}/api/stats`, fetcher, { refreshInterval: 30000 });
  const { data: logs } = useSWR<string[]>(`${base}/api/logs?limit=200`, fetcher, { refreshInterval: 5000 });

  // ── PostgreSQL 카메라 목록 (Dashboard / Overview 섹션의 권위 소스) ─────────
  // 5초마다 갱신 → 웹에서 삭제·수정 시 즉시 반영
  const { data: dbCameras } = useSWR<DbCamera[]>(
    `/api/cameras/${customer.id}`,
    fetcher,
    { refreshInterval: 5000 }
  );

  // ── DB 카메라 + rtpulse 지표 병합 → Dashboard & Overview 용 ──────────────
  const dbStreams = useMemo(
    () => (dbCameras ? buildDbStreams(dbCameras, rtStreams ?? []) : undefined),
    [dbCameras, rtStreams]
  );

  // DB 기준 Aggregate (rtpulse의 /api/aggregate 대신 직접 계산)
  const dbAggregate = useMemo(
    () => (dbStreams ? computeAggregate(dbStreams) : undefined),
    [dbStreams]
  );

  // ── rtpulse 연결 상태 ──────────────────────────────────────────────────────
  // 프록시는 rtpulse 미도달 시 502 + { error } 를 반환한다(=info.error).
  // 로드 완료(info 존재) 후 error 필드가 있거나 SWR fetch 자체가 실패하면 다운으로 간주.
  const rtpulseDown = !!infoError || (info != null && !!(info as { error?: string }).error);

  // rtpulse가 죽어 있으면 "데이터 Watch"로 자동 전환(사용자가 탭을 직접 고르기 전까지).
  const manualTab = useRef(false);
  const selectTab = (t: Tab) => { manualTab.current = true; setTab(t); };
  useEffect(() => {
    if (rtpulseDown && !manualTab.current && tab === "stream") setTab("data");
  }, [rtpulseDown, tab]);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">{customer.name}</h1>
          <p className="text-xs text-faint mt-1">
            {customer.apiUrl} · v{info?.version ?? "—"} · 스트림 {info?.stream_count ?? "—"}개
          </p>
        </div>
        <div className="flex gap-2">
          {tab === "stream" && (
            <button
              onClick={() => setShowCameraModal(true)}
              className="px-3 py-1.5 text-xs bg-cyan-50 border border-cyan-400 text-cyan-700 hover:bg-cyan-100 dark:bg-cyan-900/50 dark:text-cyan-400 dark:border-cyan-800 dark:hover:bg-cyan-900 rounded-lg"
            >
              + 카메라 등록
            </button>
          )}
          <a
            href={`/customers/${customer.id}/edit`}
            className="px-3 py-1.5 text-xs bg-input text-ink2 border border-line2 rounded-lg hover:bg-gray-700"
          >
            수정
          </a>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-line">
        <TabButton active={tab === "stream"} onClick={() => selectTab("stream")}>
          스트림 Watch{rtpulseDown && <span className="ml-1 text-amber-400" title="rtpulse 연결 안 됨">●</span>}
        </TabButton>
        <TabButton active={tab === "data"}   onClick={() => selectTab("data")}>데이터 Watch</TabButton>
        <TabButton active={tab === "status"} onClick={() => selectTab("status")}>Status Watch</TabButton>
      </div>

      {/* 스트림 Watch: rtpulse 미연결 시 실행 안내로 대체 */}
      {tab === "stream" && rtpulseDown && (
        <RtpulseGuide customer={customer} onGoData={() => selectTab("data")} />
      )}

      {tab === "stream" && !rtpulseDown && (
        <div className="space-y-8">
          {showCameraModal && (
            <CameraRegisterModal
              customerId={customer.id}
              onClose={() => setShowCameraModal(false)}
              onDone={(count) => {
                setShowCameraModal(false);
                setCameraAddedCount((n) => n + count);
                setCameraRefreshKey((k) => k + 1);
              }}
            />
          )}

          {cameraAddedCount > 0 && (
            <div className="px-4 py-2 bg-green-900/40 border border-green-800 rounded-lg text-xs text-green-400">
              카메라 {cameraAddedCount}대 등록됨 — rtpulse가 모니터링을 시작합니다.
            </div>
          )}

          {/*
           * Section 1: Dashboard
           * DB 카메라 목록 기준 — 삭제·수정 즉시 반영 (최대 5초)
           * 실시간 지표(health, bitrate…)는 rtpulse에서 오버레이
           */}
          <Section title="1. Dashboard" id="dashboard">
            <DashboardSection streams={dbStreams ?? []} aggregate={dbAggregate} />
          </Section>

          {/*
           * Section 2: Overview
           * 동일하게 DB 카메라 기준
           */}
          <Section title="2. Overview" id="overview">
            <OverviewSection streams={dbStreams ?? []} />
          </Section>

          {/*
           * Section 3: Detail
           * 스파크라인 등 rtpulse 내부 시계열 데이터가 필요하므로 rtpulse 기준 유지
           */}
          <Section title="3. Detail" id="detail">
            <DetailSection streams={rtStreams ?? []} />
          </Section>

          {/* Section 4: Logs */}
          <Section title="4. Logs" id="logs">
            <LogsSection logs={logs ?? []} />
          </Section>

          {/* Section 5: Stats */}
          <Section title="5. Stats" id="stats">
            <StatsSection stats={stats} customerName={customer.name} />
          </Section>

          {/* Section 6: 카메라 목록 */}
          <Section title="6. 카메라 목록" id="cameras">
            <CamerasSection key={cameraRefreshKey} customerId={customer.id} />
          </Section>
        </div>
      )}

      {tab === "data" && (
        <DataWatch customer={customer} />
      )}

      {/* Status Watch — 중앙 메트릭이 연결된 고객사는 그쪽을 보여주고(이력·GPU·스트림까지),
          metricsLabel 이 없으면 기존 SSH 실시간 조회로 폴백한다. */}
      {tab === "status" && (
        customer.metricsLabel
          ? <CentralMetrics customer={customer} />
          : <StatusWatch customer={customer} />
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-cyan-500 text-cyan-400"
          : "border-transparent text-faint hover:text-ink2"
      }`}
    >
      {children}
    </button>
  );
}

// ── rtpulse 미연결 시 실행 안내 ────────────────────────────────────────────────

function RtpulseGuide({ customer, onGoData }: { customer: Customer; onGoData: () => void }) {
  const [method, setMethod] = useState<"tmux" | "systemd">("systemd");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // 고객사 등록정보 매핑 — 비어 있으면 안내용 플레이스홀더 유지
  const sshUser  = customer.sshUser?.trim() || "[ssh 사용자]";
  const serverIp = customer.ip?.trim()      || "[서버 IP]";
  const runArgs  = `--api-url https://watch.example.com --api-port 9999 --customer-id ${customer.id}`;

  const tmuxCmd =
    `ssh ${sshUser}@${serverIp}\n` +
    `tmux\n` +
    `cd rtpulse\n` +
    `./rtpulse ${runArgs}`;

  const systemdCmd =
    `ssh ${sshUser}@${serverIp}\n\n` +
    `# rtpulse 서비스 등록 (부팅 시 자동 시작 · 비정상 종료 시 자동 재시작)\n` +
    `# rtpulse는 터미널 UI(TUI)라 pty가 필요 → script로 pty를 물려 실행 (없으면 os error 6로 즉시 종료)\n` +
    `sudo tee /etc/systemd/system/rtpulse.service > /dev/null <<'EOF'\n` +
    `[Unit]\n` +
    `Description=rtpulse stream monitor\n` +
    `After=network-online.target\n` +
    `Wants=network-online.target\n\n` +
    `[Service]\n` +
    `Type=simple\n` +
    `User=${sshUser}\n` +
    `WorkingDirectory=/home/${sshUser}/rtpulse\n` +
    `ExecStart=/usr/bin/script -qfec "/home/${sshUser}/rtpulse/rtpulse ${runArgs}" /dev/null\n` +
    `StandardOutput=null\n` +
    `StandardError=journal\n` +
    `Restart=always\n` +
    `RestartSec=5\n\n` +
    `[Install]\n` +
    `WantedBy=multi-user.target\n` +
    `EOF\n\n` +
    `sudo systemctl daemon-reload\n` +
    `sudo systemctl enable --now rtpulse`;

  const statusCmd = `sudo systemctl status rtpulse\njournalctl -u rtpulse -f`;

  const missing: string[] = [];
  if (!customer.sshUser?.trim()) missing.push("SSH 사용자");
  if (!customer.ip?.trim()) missing.push("서버 IP");

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch { /* 클립보드 불가 시 무시 */ }
  };

  const CmdBlock = ({ id, text }: { id: string; text: string }) => (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-line bg-panel px-4 py-3 pr-16 text-xs font-mono text-ink2 leading-relaxed whitespace-pre">{text}</pre>
      <button
        type="button"
        onClick={() => copy(id, text)}
        className="absolute top-2 right-2 px-2 py-1 text-[11px] rounded-md bg-input border border-line2 text-muted hover:text-ink hover:bg-gray-700 transition-colors"
      >
        {copiedKey === id ? "복사됨" : "복사"}
      </button>
    </div>
  );

  const TabBtn = ({ value, label, hint }: { value: "tmux" | "systemd"; label: string; hint: string }) => (
    <button
      type="button"
      onClick={() => setMethod(value)}
      className={`flex-1 text-left px-3 py-2 rounded-lg border transition-colors ${
        method === value
          ? "border-cyan-500 bg-cyan-500/10 text-ink"
          : "border-line2 bg-input/40 text-muted hover:text-ink2 hover:border-line"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">{label}</span>
        {value === "systemd" && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-900/50 text-cyan-300 border border-cyan-700/50">권장</span>
        )}
      </div>
      <p className="mt-0.5 text-[11px] text-faint leading-snug">{hint}</p>
    </button>
  );

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-6 space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-amber-400 text-xl leading-none">⚠</span>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-ink">rtpulse가 연결되어 있지 않습니다</h3>
          <p className="text-xs text-muted leading-relaxed">
            {customer.name} 서버의 rtpulse 스트림 모니터에 연결할 수 없습니다.
            아래 방법 중 하나로 실행하세요. 실행되면 스트림 지표가 자동으로 표시됩니다.
          </p>
        </div>
      </div>

      {/* 실행 방법 선택 */}
      <div className="flex gap-2">
        <TabBtn value="systemd" label="상시 실행 (systemd)" hint="부팅 시 자동 시작 · 죽으면 자동 재시작" />
        <TabBtn value="tmux"    label="빠른 실행 (tmux)"    hint="지금 한 번 실행 · 세션 유지 필요" />
      </div>

      {method === "tmux" ? (
        <CmdBlock id="tmux" text={tmuxCmd} />
      ) : (
        <div className="space-y-2">
          <CmdBlock id="systemd" text={systemdCmd} />
          <p className="text-[11px] text-faint">상태 확인:</p>
          <CmdBlock id="status" text={statusCmd} />
        </div>
      )}

      {missing.length > 0 && (
        <p className="text-[11px] text-amber-400">
          ⚠ 고객사 등록정보에 {missing.join(", ")} 이(가) 없어 명령에 채우지 못했습니다.
          <a href={`/customers/${customer.id}/edit`} className="ml-1 underline hover:text-amber-300">수정에서 입력</a>
        </p>
      )}

      <div className="flex items-center gap-3 pt-1 border-t border-line/60">
        <button
          type="button"
          onClick={onGoData}
          className="mt-3 px-3 py-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded-lg transition-colors"
        >
          데이터 Watch로 이동
        </button>
        <span className="mt-3 text-[11px] text-faint">rtpulse 없이도 데이터 Watch(이벤트·통계·NAS)는 사용할 수 있습니다.</span>
      </div>
    </div>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section id={id}>
      <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
        {title}
      </h2>
      {children}
    </section>
  );
}
