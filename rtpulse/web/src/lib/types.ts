export interface PromptRecord {
  notionId: string;
  version: string;
  basePrompt: string;
  assignees: string[];
  appliedAt: string | null;
  huggingfaceUrl: string | null;
  notionUrl: string;
  registeredAt: string; // 이 고객사에 등록한 시각
  isActive: boolean;    // 현재 사용 중인 버전 여부
}

/** 네트워크 유형: remote = VPN/Headscale 원격, onprem = 망분리 온프레미스 */
export type NetworkType = "remote" | "onprem";

export interface Customer {
  id: string;
  name: string;
  networkType: NetworkType;  // 네트워크 유형 (default: "remote")
  apiUrl: string;            // computed: http://{ip}:{rtpulsePort}
  ip?: string;               // 고객사 서버 IP
  rtpulsePort?: number;      // rtpulse API 포트 (default: 9999)
  timezone?: string;         // IANA 타임존 (default: "Asia/Seoul")
  description?: string;
  slackWebhook?: string;
  // VMS 연결 (MariaDB, MinIO 등 서비스 VIP)
  vip?: string;              // VIP (Virtual-IP) — VMS 서비스 IP
  dbName?: string;           // DB 이름 (예: ims-db)
  dbPort?: number;           // MySQL 포트 (default: 3306)
  dbUser?: string;           // DB 사용자 (default: ops)
  dbPassword?: string;
  // NAS / SSH
  sshUser?: string;          // SSH 사용자 (NAS 업로드용, default: dbUser)
  sshPassword?: string;      // SSH 비밀번호 (미입력 시 DB 비밀번호 사용)
  nasPath?: string;          // NAS 마운트 경로 (default: /rtpulse)
  // 중앙 메트릭 (central-metrics / VictoriaMetrics)
  // 고객사 Prometheus 의 external_labels.customer 값. 예: "site-b", "site-e".
  // 비어 있으면 Status Watch 가 기존 SSH 실시간 조회로 동작한다.
  metricsLabel?: string;
  createdAt: string;
}

export type StreamHealth = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface ApiStream {
  id: number;
  name: string;
  url: string;
  protocol: string;
  health: StreamHealth;
  bitrate_kbps: number;
  packet_loss_pct: number;
  jitter_ms: number;
  fps: number;
  uptime_secs: number;
  last_update: number;
}

export interface ApiAggregate {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  unknown: number;
  total_bitrate_kbps: number;
  avg_loss_pct: number;
  avg_jitter_ms: number;
}

export interface ApiInfo {
  version: string;
  stream_count: number;
  captured_at: number;
}

export interface ApiEventLogEntry {
  stream_name: string;
  event_kind: "DOWN" | "WARNING" | "RECONNECT";
  cause: string;
  happened_at_epoch: number;
}

export interface ApiStatsRow {
  stream_id: number;
  stream_name: string;
  down_count: number;
  warn_count: number;
  reconnect_count: number;
  last_event_epoch: number | null;
}

export interface ApiDownSummary {
  downs_today: number;
  downs_last_7d: number;
  downs_last_30d: number;
  last_down_epoch: number | null;
}

export interface ApiStats {
  filter: string;
  summary: ApiDownSummary;
  stream_rows: ApiStatsRow[];
  filter_trend: number[];
  event_log: ApiEventLogEntry[];
}

export interface CustomerStatus {
  customer: Customer;
  info?: ApiInfo;
  aggregate?: ApiAggregate;
  stats?: ApiStats;
  reachable: boolean;
  error?: string;
}
