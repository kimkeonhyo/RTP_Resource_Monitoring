/**
 * GET /api/customers/{id}/k8s-status
 *
 * 원격 고객사의 K8s 클러스터 상태를 수집합니다.
 *
 * 수집 방법:
 *   1. K8s API 헬스체크 — https://{customer.vip}:6443/healthz (인증 불필요)
 *      vip = Tailscale Gateway 주소
 *   2. SSH → {customer.ip} (하드웨어 IP) 에 접속해 kubectl + 시스템 명령 실행
 *      ip = 물리 서버 IP
 *
 * 반환 데이터:
 *   - K8s API 상태 (ok / error / unreachable)
 *   - 노드 목록 (이름, Ready 여부, 역할, 버전, CPU/Memory 사용률)
 *   - 시스템 메트릭 (Load, Memory, Disk, 네트워크 누적 트래픽, kubelet 상태)
 */
import { NextRequest, NextResponse } from "next/server";
import { Client as SshClient } from "ssh2";
import { getCustomer } from "@/lib/customers";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// ── 타입 ────────────────────────────────────────────────────────────────────

export interface K8sNode {
  name: string;
  status: "Ready" | "NotReady" | "Unknown";
  roles: string;
  version: string;
  internalIp: string;
  age: string;
  cpuUsage?: string;   // e.g. "450m"
  cpuPct?: number;     // e.g. 22
  memUsage?: string;   // e.g. "2Gi"
  memPct?: number;     // e.g. 26
}

export interface NetIface {
  name: string;
  rxBytes: number;
  txBytes: number;
}

export interface K8sStatusResult {
  checkedAt: string;
  sshReachable: boolean;
  apiHealth: "ok" | "error" | "unreachable" | "skipped";
  apiResponseMs?: number;
  kubeletStatus?: "active" | "inactive" | "unknown";
  podCount?: number;
  nodes: K8sNode[];
  systemCpu?: { load1: number; load5: number; load15: number; cores: number };
  systemMemory?: { totalMb: number; usedMb: number; availMb: number };
  systemDisk?: { size: string; used: string; avail: string; usePct: string };
  systemNetwork?: NetIface[];
  error?: string;
}

// ── K8s API healthz 체크 ─────────────────────────────────────────────────────

async function checkK8sApiHealth(
  vip: string
): Promise<{ status: "ok" | "error" | "unreachable"; responseMs?: number }> {
  const https = await import("node:https");
  const start = Date.now();

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: "unreachable" }), 6_000);

    const req = https.request(
      {
        hostname: vip,
        port: 6443,
        path: "/healthz",
        method: "GET",
        rejectUnauthorized: false, // K8s 자체 서명 인증서 허용
        timeout: 5_000,
      },
      (res) => {
        clearTimeout(timer);
        let body = "";
        res.on("data", (d: Buffer) => (body += d.toString()));
        res.on("end", () => {
          resolve({
            status: body.trim() === "ok" ? "ok" : "error",
            responseMs: Date.now() - start,
          });
        });
      }
    );

    req.on("error", () => {
      clearTimeout(timer);
      resolve({ status: "unreachable" });
    });
    req.on("timeout", () => {
      clearTimeout(timer);
      req.destroy();
      resolve({ status: "unreachable" });
    });
    req.end();
  });
}

// ── SSH 연결 / 명령 실행 ──────────────────────────────────────────────────────

function connectSsh(host: string, user: string, password: string): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const c = new SshClient();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { c.destroy(); } catch { /* ignore */ }
        reject(new Error("SSH 연결 타임아웃 (10s)"));
      }
    }, 10_000);

    const fail = (e: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { c.destroy(); } catch { /* ignore */ }
        reject(e);
      }
    };

    c.on("error", fail);
    c.on("ready", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(c);
      }
    });
    c.connect({ host, port: 22, username: user, password, readyTimeout: 8_000 });
  });
}

function sshExec(conn: SshClient, command: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSH exec 타임아웃")), timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      let out = "";
      stream.on("data", (d: Buffer) => (out += d.toString()));
      stream.stderr.on("data", () => { /* stderr 무시 */ });
      stream.on("close", () => { clearTimeout(timer); resolve(out); });
    });
  });
}

// ── 파싱 헬퍼 ────────────────────────────────────────────────────────────────

/** "===SECTION===" 구분자로 SSH 출력을 섹션별로 분리 */
function parseSections(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = raw.split(/^===([A-Z]+)===/m);
  for (let i = 1; i < parts.length; i += 2) {
    result[parts[i]] = (parts[i + 1] ?? "").trim();
  }
  return result;
}

interface KubeNodeJson {
  metadata: {
    name: string;
    labels: Record<string, string>;
    creationTimestamp: string;
  };
  status: {
    conditions?: { type: string; status: string }[];
    nodeInfo: { kubeletVersion: string };
    addresses?: { type: string; address: string }[];
  };
}

function calcAge(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days > 0) return `${days}d`;
  const hrs = Math.floor(diffMs / 3_600_000);
  return `${hrs}h`;
}

function parseNodes(nodesJson: string, topRaw: string): K8sNode[] {
  let items: KubeNodeJson[] = [];
  try {
    const parsed = JSON.parse(nodesJson);
    items = parsed.items ?? [];
  } catch { return []; }

  // kubectl top nodes --no-headers: "nodeName  450m  22%  2048Mi  26%"
  const topMap: Record<string, Pick<K8sNode, "cpuUsage" | "cpuPct" | "memUsage" | "memPct">> = {};
  for (const line of topRaw.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 5 && cols[0]) {
      topMap[cols[0]] = {
        cpuUsage: cols[1],
        cpuPct:   parseInt(cols[2]) || 0,
        memUsage: cols[3],
        memPct:   parseInt(cols[4]) || 0,
      };
    }
  }

  return items.map((item): K8sNode => {
    const readyCond = item.status.conditions?.find((c) => c.type === "Ready");
    const status: K8sNode["status"] =
      readyCond?.status === "True"  ? "Ready"    :
      readyCond?.status === "False" ? "NotReady" : "Unknown";

    const roles = Object.keys(item.metadata.labels ?? {})
      .filter((l) => l.startsWith("node-role.kubernetes.io/"))
      .map((l) => l.replace("node-role.kubernetes.io/", ""))
      .join(", ") || "worker";

    const internalIp =
      item.status.addresses?.find((a) => a.type === "InternalIP")?.address ?? "";

    return {
      name: item.metadata.name,
      status,
      roles,
      version: item.status.nodeInfo?.kubeletVersion ?? "—",
      internalIp,
      age: calcAge(item.metadata.creationTimestamp),
      ...topMap[item.metadata.name],
    };
  });
}

/**
 * /proc/meminfo 파싱 (로케일 무관, 항상 영문 키)
 *
 * 예시:
 *   MemTotal:       32185312 kB
 *   MemFree:          636788 kB
 *   MemAvailable:   10240512 kB
 *
 * usedMb = totalMb - availMb  (reclaimable 캐시 제외한 실 사용량)
 */
function parseMemory(raw: string): K8sStatusResult["systemMemory"] {
  const getKb = (key: string): number => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? parseInt(m[1]) : 0;
  };
  const totalKb = getKb("MemTotal");
  if (!totalKb) return undefined;
  const availKb = getKb("MemAvailable");
  const usedKb  = totalKb - availKb; // total - available ≈ 실 점유 메모리
  return {
    totalMb: Math.round(totalKb / 1024),
    usedMb:  Math.round(usedKb  / 1024),
    availMb: Math.round(availKb / 1024),
  };
}

function parseDisk(raw: string): K8sStatusResult["systemDisk"] {
  // df -h / | tail -1 → "/dev/sda1  100G  45G  55G  45%  /"
  const cols = raw.trim().split(/\s+/);
  if (cols.length < 5) return undefined;
  return { size: cols[1], used: cols[2], avail: cols[3], usePct: cols[4] };
}

function parseLoad(
  loadRaw: string,
  nprocRaw: string
): K8sStatusResult["systemCpu"] {
  const parts = loadRaw.trim().split(/\s+/);
  if (parts.length < 3) return undefined;
  return {
    load1:  parseFloat(parts[0]) || 0,
    load5:  parseFloat(parts[1]) || 0,
    load15: parseFloat(parts[2]) || 0,
    cores:  parseInt(nprocRaw.trim()) || 1,
  };
}

function parseNetDev(raw: string): NetIface[] {
  const ifaces: NetIface[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("|")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const name = trimmed.slice(0, colonIdx).trim();
    if (name === "lo") continue; // 루프백 제외
    const cols = trimmed.slice(colonIdx + 1).trim().split(/\s+/);
    ifaces.push({
      name,
      rxBytes: parseInt(cols[0]) || 0,
      txBytes: parseInt(cols[8]) || 0,
    });
  }
  return ifaces;
}

// ── Slack 알람 ────────────────────────────────────────────────────────────────

/** 고객사 × 알람 종류별 마지막 전송 시각 (프로세스 재시작 시 초기화) */
const alertCooldown = new Map<string, number>();
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10분

/** 쿨다운이 지났으면 true 반환 후 타임스탬프 갱신 */
function canAlert(key: string): boolean {
  const last = alertCooldown.get(key) ?? 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  alertCooldown.set(key, Date.now());
  return true;
}

interface SlackAlert {
  type: "critical" | "warning";
  title: string;
  message: string;
}

async function sendSlackAlerts(
  webhookUrl: string,
  customerName: string,
  alerts: SlackAlert[]
): Promise<void> {
  if (!alerts.length) return;

  const critical = alerts.filter((a) => a.type === "critical");
  const warnings  = alerts.filter((a) => a.type === "warning");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachments: any[] = [];
  const ts = Math.floor(Date.now() / 1000);

  if (critical.length) {
    attachments.push({
      color:  "#FF3B30",
      title:  `🚨 [${customerName}] 서버 이상 감지`,
      text:   critical.map((a) => `• *${a.title}*: ${a.message}`).join("\n"),
      footer: "RTPulse · Status Watch",
      ts,
    });
  }
  if (warnings.length) {
    attachments.push({
      color:  "#FF9500",
      title:  `⚠️ [${customerName}] 리소스 경고`,
      text:   warnings.map((a) => `• *${a.title}*: ${a.message}`).join("\n"),
      footer: "RTPulse · Status Watch",
      ts,
    });
  }

  await fetch(webhookUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ attachments }),
  });
}

// ── 메인 핸들러 ──────────────────────────────────────────────────────────────

export async function GET(_: NextRequest, { params }: Params) {
  const { id } = await params;
  const customer = await getCustomer(id);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result: K8sStatusResult = {
    checkedAt:    new Date().toISOString(),
    sshReachable: false,
    apiHealth:    "skipped",
    nodes:        [],
  };

  // ── 1. K8s API healthz ────────────────────────────────────────────────────
  // VIP(Tailscale Gateway) 우선, 응답 없으면 ip(하드웨어 IP)에서도 시도
  const apiHealthPromise: Promise<{ status: "ok" | "error" | "unreachable" | "skipped"; responseMs?: number }> =
    (async () => {
      if (!customer.vip && !customer.ip) return { status: "skipped" as const };

      if (customer.vip) {
        const res = await checkK8sApiHealth(customer.vip);
        if (res.status !== "unreachable") return res;
        // VIP 실패 → ip로 폴백
      }
      if (customer.ip) {
        return checkK8sApiHealth(customer.ip);
      }
      return { status: "skipped" as const };
    })();

  // ── 2. SSH → 하드웨어 IP로 접속해 kubectl + 시스템 메트릭 수집 ──────────────
  const sshPromise: Promise<Record<string, string> | null> = customer.ip
    ? (async () => {
        const user = customer.sshUser ?? "root";
        // sshPassword 전용 — dbPassword 폴백 제거 (별도 서비스 자격증명 혼용 방지)
        const pass = customer.sshPassword ?? "";
        if (!pass) {
          result.error = "SSH 비밀번호가 설정되지 않았습니다. 고객사 수정 → SSH 비밀번호를 입력하세요.";
          return null;
        }

        let conn: SshClient | null = null;
        try {
          conn = await connectSsh(customer.ip!, user, pass);

          // 단일 exec 으로 모든 정보 수집 (RTT 최소화)
          const cmd = [
            "echo '===NODES==='",
            // kubectl JSON 출력 (노드 목록)
            "kubectl get nodes -o json 2>/dev/null || echo '{}'",
            "echo '===TOP==='",
            // kubectl top nodes (metrics-server 필요, 없으면 빈 출력)
            "kubectl top nodes --no-headers 2>/dev/null || true",
            "echo '===FREE==='",
            // /proc/meminfo 는 로케일 무관, 항상 영문 키 출력 → free -m 대체
            "grep -E '^(MemTotal|MemFree|MemAvailable):' /proc/meminfo 2>/dev/null || true",
            "echo '===DF==='",
            "df -h / 2>/dev/null | tail -1 || true",
            "echo '===LOAD==='",
            "cat /proc/loadavg 2>/dev/null || true",
            "echo '===NPROC==='",
            "nproc 2>/dev/null || echo 1",
            "echo '===NETDEV==='",
            "cat /proc/net/dev 2>/dev/null | tail -n +3 || true",
            "echo '===PODS==='",
            "kubectl get pods -A --no-headers 2>/dev/null | wc -l || echo 0",
            "echo '===KUBELET==='",
            "systemctl is-active kubelet 2>/dev/null || echo unknown",
          ].join("; ");

          const raw = await sshExec(conn, cmd, 30_000);
          conn.end();
          return parseSections(raw);
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e);
          try { conn?.end(); } catch { /* ignore */ }
          return null;
        }
      })()
    : (() => {
        result.error = "고객사에 하드웨어 IP(ip)가 설정되지 않았습니다.";
        return Promise.resolve(null);
      })();

  // ── 병렬 실행 ──────────────────────────────────────────────────────────────
  const [apiHealthRaw, sections] = await Promise.all([apiHealthPromise, sshPromise]);

  result.apiHealth    = apiHealthRaw.status;
  result.apiResponseMs = "responseMs" in apiHealthRaw ? apiHealthRaw.responseMs : undefined;

  if (sections) {
    result.sshReachable   = true;
    result.nodes          = parseNodes(sections["NODES"] ?? "{}", sections["TOP"] ?? "");
    result.systemMemory   = parseMemory(sections["FREE"] ?? "");
    result.systemDisk     = parseDisk(sections["DF"] ?? "");
    result.systemCpu      = parseLoad(sections["LOAD"] ?? "", sections["NPROC"] ?? "1");
    result.systemNetwork  = parseNetDev(sections["NETDEV"] ?? "");
    result.podCount       = parseInt(sections["PODS"] ?? "0") || 0;

    const kubeletRaw = (sections["KUBELET"] ?? "").trim();
    result.kubeletStatus =
      kubeletRaw === "active"   ? "active"   :
      kubeletRaw === "inactive" ? "inactive" : "unknown";
  }

  // ── Slack 알람 체크 ──────────────────────────────────────────────────────────
  if (customer.slackWebhook) {
    const alerts: SlackAlert[] = [];

    // ① SSH 접속 불가 (서버 다운 or 자격증명 오류 제외)
    if (!result.sshReachable && result.error && !result.error.includes("비밀번호") && canAlert(`${id}:ssh`)) {
      alerts.push({ type: "critical", title: "SSH 접속 불가", message: result.error });
    }

    // ② K8s API 응답 없음
    if (result.apiHealth === "unreachable" && canAlert(`${id}:api_unreachable`)) {
      alerts.push({
        type: "critical",
        title: "K8s API 응답 없음",
        message: `${customer.vip ?? customer.ip ?? ""}:6443 응답 없음`,
      });
    }

    // ③ K8s API 오류
    if (result.apiHealth === "error" && canAlert(`${id}:api_error`)) {
      alerts.push({ type: "critical", title: "K8s API 오류", message: "healthz 가 ok 이외 응답 반환" });
    }

    // ④ NotReady 노드
    for (const node of result.nodes.filter((n) => n.status !== "Ready")) {
      if (canAlert(`${id}:node_${node.name}`)) {
        alerts.push({ type: "critical", title: `노드 NotReady`, message: `${node.name} (${node.roles})` });
      }
    }

    // ⑤ kubelet 비활성
    if (result.kubeletStatus === "inactive" && canAlert(`${id}:kubelet`)) {
      alerts.push({ type: "critical", title: "kubelet 비활성", message: "systemctl is-active kubelet → inactive" });
    }

    // ⑥ 메모리 > 85%
    if (result.systemMemory) {
      const pct = result.systemMemory.totalMb
        ? result.systemMemory.usedMb / result.systemMemory.totalMb
        : 0;
      if (pct > 0.85 && canAlert(`${id}:mem`)) {
        alerts.push({
          type: "warning",
          title: "메모리 사용량 높음",
          message: `${Math.round(pct * 100)}%  (${result.systemMemory.usedMb} MB / ${result.systemMemory.totalMb} MB)`,
        });
      }
    }

    // ⑦ 디스크 > 85%
    if (result.systemDisk) {
      const diskPct = parseInt(result.systemDisk.usePct) || 0;
      if (diskPct > 85 && canAlert(`${id}:disk`)) {
        alerts.push({
          type: "warning",
          title: "디스크 사용량 높음",
          message: `${result.systemDisk.usePct}  (${result.systemDisk.used} / ${result.systemDisk.size})`,
        });
      }
    }

    // ⑧ CPU Load1 > 코어 수 × 0.9
    if (result.systemCpu) {
      const { load1, cores } = result.systemCpu;
      if (load1 > cores * 0.9 && canAlert(`${id}:cpu`)) {
        alerts.push({
          type: "warning",
          title: "CPU 부하 높음",
          message: `Load1: ${load1}  (코어 수: ${cores})`,
        });
      }
    }

    if (alerts.length > 0) {
      sendSlackAlerts(customer.slackWebhook, customer.name, alerts).catch(() => {});
    }
  }

  return NextResponse.json(result);
}
