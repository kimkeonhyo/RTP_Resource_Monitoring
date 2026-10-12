import { NextRequest, NextResponse } from "next/server";
import {
  hostsInGroups, latestByName, latestByPrefix, latestContains, problemsForHosts, zabbixWebUrl,
  type ZbxItem,
} from "@/lib/zabbix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/serverroom/switch | /api/serverroom/server
 *
 * 서버실 장비 현황. Zabbix 를 그대로 옮겨오지 않고 한눈에 볼 값만 추린다.
 * 자세한 그래프는 Zabbix 링크로 넘긴다.
 */

const GROUPS: Record<string, string[]> = {
  switch: ["IMS 네트워크 장비"],
  server: ["IMS 서버·워크스테이션"],
  cloud: ["IMS 클라우드"],
};

// 아이템 이름은 템플릿마다 달라 후보를 여러 개 둔다. 먼저 찾은 것을 쓴다.
const COMMON = ["ICMP ping", "ICMP loss", "ICMP response time",
                "Uptime", "System uptime", "Uptime (network)", "Uptime (hardware)"];

// 스위치는 벤더마다 이름이 다르다. r=MikroTik, sw-access/office=TP-Link, sw-core=NETGEAR.
const SW_CPU = ["CPU utilization", "#1: CPU utilization", "NETGEAR: CPU utilization"];
const SW_MEM = ["Memory utilization", "#1: Memory utilization", "NETGEAR: Memory utilization"];
// NAS 는 벤더 템플릿이라 이름이 한국어다 (IMS Synology NAS by SNMP).
const SRV_CPU = ["CPU utilization", "CPU 사용률"];
const SRV_MEM = ["Memory utilization", "메모리 사용률"];
const SERVER_ITEMS = [
  ...COMMON, ...SRV_CPU, ...SRV_MEM,
  "Available memory in %", "FS [/]: Space: Used, in %", "Load average (1m avg)",
  "System name", "Operating system",
];
const SWITCH_ITEMS = [
  ...COMMON, ...SW_CPU, ...SW_MEM,
  "CPU: Temperature", "System name", "Hardware model name", "System description",
];

export type DeviceRow = {
  hostid: string;
  host: string;
  name: string;
  ip: string | null;
  /** ok = 응답함, down = 응답 없음, unknown = 판단 불가 */
  state: "ok" | "down" | "unknown";
  /** Zabbix 모니터링 활성 여부(status=1 이면 비활성) */
  enabled: boolean;
  problems: { name: string; severity: number }[];
  metrics: Record<string, { value: number | string; units: string }>;
  gpu?: { count: number; utilMax: number | null; tempMax: number | null };
  /** 스위치 — 링크가 올라온 포트 현황 */
  ports?: { up: number; maxPct: number | null; busiest: string | null };
};

export type ServerRoomResult = {
  kind: string;
  updatedAt: string;
  zabbixUrl: string | null;
  devices: DeviceRow[];
};

const num = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function pick(items: ZbxItem[], names: string[]): ZbxItem | undefined {
  for (const n of names) {
    const hit = items.find((i) => i.name === n);
    if (hit) return hit;
  }
  return undefined;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  const groups = GROUPS[kind];
  if (!groups) return NextResponse.json({ error: "알 수 없는 종류입니다" }, { status: 400 });

  try {
    // 서브NIC 호스트는 같은 장비의 보조 인터페이스(의도적 다운)라 목록에서 제외
    const hosts = (await hostsInGroups(groups)).filter((h) => !/서브\s*NIC/i.test(h.name));
    const hostids = hosts.map((h) => h.hostid);
    const wanted = kind === "switch" ? SWITCH_ITEMS : SERVER_ITEMS;

    const none = Promise.resolve([] as ZbxItem[]);
    const [items, problems, gpuItems, portItems, netItems, volItems] = await Promise.all([
      latestByName(hostids, wanted),
      problemsForHosts(hostids),
      kind !== "switch" ? latestByPrefix(hostids, "GPU ") : none,
      kind === "switch" ? latestByPrefix(hostids, "사용률: ") : none,
      latestContains(hostids, "Bits "),   // 트래픽: "...: Bits received/sent"
      // NAS 는 루트 파일시스템 대신 볼륨별 사용률로 들어온다.
      // 시놀로지는 "Volume 1: 사용률", ASUSTOR(hrStorage)는 "/volume1: 사용률".
      kind !== "switch" ? latestContains(hostids, ": 사용률") : none,
    ]);

    const byHost = new Map<string, ZbxItem[]>();
    for (const i of items) {
      if (!byHost.has(i.hostid)) byHost.set(i.hostid, []);
      byHost.get(i.hostid)!.push(i);
    }
    const group = (list: ZbxItem[]) => {
      const m = new Map<string, ZbxItem[]>();
      for (const i of list) {
        if (i.lastclock === "0") continue;
        if (!m.has(i.hostid)) m.set(i.hostid, []);
        m.get(i.hostid)!.push(i);
      }
      return m;
    };
    const gpuByHost  = group(gpuItems);
    const portByHost = group(portItems);
    const netByHost  = group(netItems);
    const volByHost  = group(volItems);

    const devices: DeviceRow[] = hosts.map((h) => {
      const its = byHost.get(h.hostid) ?? [];
      const ping = pick(its, ["ICMP ping"]);
      const ifAvail = (h.interfaces ?? []).map((i) => i.available);
      // 최근(10분 내) 수신한 지표가 있으면 살아있는 것으로 본다 (SNMP 장비는 ping·agent IF가 없음)
      const nowSec = Date.now() / 1000;
      const hasRecent = its.some((i) => i.lastclock !== "0" && nowSec - Number(i.lastclock) < 600);
      const state: DeviceRow["state"] =
        ping ? (ping.lastvalue === "1" ? "ok" : "down")
             : ifAvail.includes("1") ? "ok"
             : hasRecent ? "ok"
             : ifAvail.includes("2") ? "down" : "unknown";

      const metrics: DeviceRow["metrics"] = {};
      const put = (label: string, names: string[]) => {
        const it = pick(its, names);
        if (!it || it.lastclock === "0") return;
        const n = num(it.lastvalue);
        metrics[label] = { value: n ?? it.lastvalue, units: it.units };
      };
      if (kind !== "switch") {
        put("cpu", SRV_CPU);
        put("mem", SRV_MEM);
        put("disk", ["FS [/]: Space: Used, in %"]);
        // 볼륨이 여럿이면 가장 찬 것을 본다 — 하나만 차도 문제다
        if (!metrics.disk) {
          const vols = (volByHost.get(h.hostid) ?? [])
            // GPU 사용률이 같은 검색에 걸리므로 볼륨 이름만 받는다
            .filter((i) => /^(Volume ?\d+|\/volume\d+): 사용률$/.test(i.name))
            .map((i) => num(i.lastvalue))
            .filter((v): v is number => v !== null);
          if (vols.length) metrics.disk = { value: Math.max(...vols), units: "%" };
        }
        put("load", ["Load average (1m avg)"]);
      } else {
        put("cpu", SW_CPU);
        put("mem", SW_MEM);
        put("temp", ["CPU: Temperature"]);
        put("model", ["System name", "Hardware model name", "System description"]);
      }
      put("loss", ["ICMP loss"]);
      put("rtt", ["ICMP response time"]);
      put("uptime", ["Uptime", "System uptime", "Uptime (network)", "Uptime (hardware)"]);

      // 트래픽: 인터페이스별 "Bits received/sent" 중 현재값이 가장 큰 것 1개씩(요약)
      const nets = netByHost.get(h.hostid) ?? [];
      const busiest = (re: RegExp) => nets
        .filter((i) => re.test(i.name))
        .map((i) => ({ v: num(i.lastvalue), units: i.units }))
        .filter((x): x is { v: number; units: string } => x.v !== null)
        .sort((a, b) => b.v - a.v)[0];
      const rx = busiest(/Bits received/i);
      const tx = busiest(/Bits sent/i);
      if (rx) metrics["net_in"]  = { value: rx.v, units: rx.units || "bps" };
      if (tx) metrics["net_out"] = { value: tx.v, units: tx.units || "bps" };

      // 포트 사용률은 "사용률: <호스트> <포트>" 로 들어온다. 링크가 있는 포트만 존재한다.
      const pts = portByHost.get(h.hostid) ?? [];
      const ranked = pts
        .map((i) => ({ name: i.name.replace(/^사용률: \S+\s*/, ""), pct: num(i.lastvalue) }))
        .filter((x): x is { name: string; pct: number } => x.pct !== null)
        .sort((a, b) => b.pct - a.pct);

      const g = gpuByHost.get(h.hostid) ?? [];
      const utils = g.filter((i) => i.name.endsWith(": 사용률")).map((i) => num(i.lastvalue)).filter((v): v is number => v !== null);
      const temps = g.filter((i) => i.name.endsWith(": 온도")).map((i) => num(i.lastvalue)).filter((v): v is number => v !== null);

      return {
        hostid: h.hostid,
        host: h.host,
        name: h.name,
        ip: h.interfaces?.find((i) => i.type === "1")?.ip ?? h.interfaces?.[0]?.ip ?? null,
        state,
        enabled: h.status !== "1",
        problems: (problems.get(h.hostid) ?? []).map((p) => ({ name: p.name, severity: Number(p.severity) })),
        metrics,
        ...(utils.length || temps.length
          ? { gpu: { count: utils.length, utilMax: utils.length ? Math.max(...utils) : null,
                     tempMax: temps.length ? Math.max(...temps) : null } }
          : {}),
        ...(ranked.length
          ? { ports: { up: ranked.length, maxPct: ranked[0].pct, busiest: ranked[0].name } }
          : {}),
      };
    });

    const result: ServerRoomResult = {
      kind, updatedAt: new Date().toISOString(), zabbixUrl: zabbixWebUrl(), devices,
    };
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
