import { NextRequest, NextResponse } from "next/server";
import {
  zabbix, hostById, itemsForHost, historyGet, problemsForHosts, zabbixWebUrl,
  type ZbxItemFull,
} from "@/lib/zabbix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/serverroom/host/{hostid}?hours=6
 *
 * 한 장비의 상세 시계열. Zabbix history.get 로 주요 지표를 끌어와 그래프용으로 반환.
 */

// 라벨 → 아이템 이름 후보(먼저 찾은 것을 그 라벨의 단일 시계열로 사용)
const SINGLE: { label: string; names: string[] }[] = [
  { label: "CPU",        names: ["CPU utilization", "CPU 사용률", "#1: CPU utilization", "NETGEAR: CPU utilization"] },
  { label: "메모리",      names: ["Memory utilization", "메모리 사용률", "#1: Memory utilization", "NETGEAR: Memory utilization"] },
  { label: "디스크 (/)",  names: ["FS [/]: Space: Used, in %"] },
  // CPU 사용률만 보면 디스크가 막힌 상황을 "CPU 바쁨" 으로 오해한다.
  // 실제로 NAS02 에서 CPU 17% / I/O 대기 79% 인데 원인을 CPU 로 읽은 적이 있다.
  { label: "I/O 대기",    names: ["CPU iowait time", "I/O 대기"] },
  // Synology 템플릿은 항목 이름이 한국어라 후보를 같이 둔다.
  { label: "Load (1m)",  names: ["Load average (1m avg)", "Load average (1분)"] },
  { label: "온도",        names: ["CPU: Temperature", "NAS 온도", "CPU 온도"] },
  { label: "응답시간",     names: ["ICMP response time"] },
];

export type Series = { label: string; units: string; points: { t: number; v: number }[] };
export type HostDetail = {
  hostid: string;
  name: string;
  ip: string | null;
  hours: number;
  zabbixUrl: string | null;
  problems: { name: string; severity: number; clock: number }[];
  series: Series[];
};

const pick = (items: ZbxItemFull[], names: string[]) => {
  for (const n of names) { const hit = items.find((i) => i.name === n); if (hit) return hit; }
  return undefined;
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ hostid: string }> }) {
  const { hostid } = await ctx.params;
  const hours = Math.min(72, Math.max(1, Number(req.nextUrl.searchParams.get("hours") ?? 6)));
  const timeFrom = Math.floor(Date.now() / 1000) - hours * 3600;

  try {
    const [host, items, probMap] = await Promise.all([
      hostById(hostid),
      itemsForHost(hostid),
      problemsForHosts([hostid]),
    ]);
    if (!host) return NextResponse.json({ error: "장비를 찾을 수 없습니다" }, { status: 404 });

    // 그래프로 뽑을 아이템 선별: 단일 지표 + GPU(장치별 사용률/온도) + 네트워크(가장 바쁜 IF in/out)
    const chosen: { label: string; item: ZbxItemFull }[] = [];
    for (const s of SINGLE) {
      const it = pick(items, s.names);
      if (it && it.lastclock !== "0") chosen.push({ label: s.label, item: it });
    }
    // GPU: "GPU N (...): 사용률" / ": 온도", Synology 볼륨: "Volume ...: 사용률"
    for (const it of items) {
      if (it.lastclock === "0") continue;
      if (/^GPU .*: 사용률$/.test(it.name)) chosen.push({ label: it.name.replace(/: 사용률$/, " 사용률"), item: it });
      else if (/^GPU .*: 온도$/.test(it.name)) chosen.push({ label: it.name.replace(/: 온도$/, " 온도"), item: it });
      // 시놀로지는 "Volume 1: 사용률", ASUSTOR 전용 MIB 는 "Volume1: 사용률"(공백 없음)
      else if (/^(Volume ?\d+|\/volume\d+): 사용률$/.test(it.name)) chosen.push({ label: it.name.replace(/: 사용률$/, " 사용률"), item: it });
    }
    // 디스크 온도: NAS 는 12개까지 나와 그래프가 묻힌다. 가장 뜨거운 것 하나만 본다.
    const hotDisk = items.filter((i) => /^Disk .*: 온도$/.test(i.name) && i.lastclock !== "0")
                         .sort((a, b) => Number(b.lastvalue) - Number(a.lastvalue))[0];
    if (hotDisk) chosen.push({ label: `디스크 온도 (${hotDisk.name.replace(/: 온도$/, "")})`, item: hotDisk });

    // 네트워크: 수신/송신 각각 현재값이 가장 큰 인터페이스 1개씩
    const netIn  = items.filter((i) => /Bits received/i.test(i.name) && i.lastclock !== "0")
                        .sort((a, b) => Number(b.lastvalue) - Number(a.lastvalue))[0];
    const netOut = items.filter((i) => /Bits sent/i.test(i.name) && i.lastclock !== "0")
                        .sort((a, b) => Number(b.lastvalue) - Number(a.lastvalue))[0];
    if (netIn)  chosen.push({ label: "트래픽 수신", item: netIn });
    if (netOut) chosen.push({ label: "트래픽 송신", item: netOut });

    // value_type 별로 history.get (0=float, 3=uint). 그 외 타입(문자열 등)은 그래프 제외.
    const byType = new Map<number, string[]>();
    for (const { item } of chosen) {
      const vt = Number(item.value_type);
      if (vt !== 0 && vt !== 3) continue;
      if (!byType.has(vt)) byType.set(vt, []);
      byType.get(vt)!.push(item.itemid);
    }
    const histResults = await Promise.all(
      [...byType.entries()].map(([vt, ids]) => historyGet(ids, vt, timeFrom)),
    );
    const pointsByItem = new Map<string, { t: number; v: number }[]>();
    for (const rows of histResults) {
      for (const r of rows) {
        const v = Number(r.value);
        if (!Number.isFinite(v)) continue;
        if (!pointsByItem.has(r.itemid)) pointsByItem.set(r.itemid, []);
        pointsByItem.get(r.itemid)!.push({ t: Number(r.clock) * 1000, v });
      }
    }

    const series: Series[] = chosen
      .map(({ label, item }) => ({ label, units: item.units, points: pointsByItem.get(item.itemid) ?? [] }))
      .filter((s) => s.points.length > 0);

    const detail: HostDetail = {
      hostid: host.hostid,
      name: host.name,
      ip: host.interfaces?.find((i) => i.type === "1")?.ip ?? host.interfaces?.[0]?.ip ?? null,
      hours,
      zabbixUrl: zabbixWebUrl(),
      problems: (probMap.get(hostid) ?? []).map((p) => ({ name: p.name, severity: Number(p.severity), clock: Number(p.clock) * 1000 })),
      series,
    };
    return NextResponse.json(detail);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

/**
 * PATCH /api/serverroom/host/{hostid}
 * Body: { name?, ip?, enabled? } — 표시 이름 / 주 인터페이스 IP / 모니터링 활성 수정
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ hostid: string }> }) {
  const { hostid } = await ctx.params;
  let body: { name?: string; ip?: string; enabled?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "본문이 JSON 이 아닙니다" }, { status: 400 }); }

  try {
    const update: Record<string, unknown> = { hostid };
    if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
    if (typeof body.enabled === "boolean") update.status = body.enabled ? 0 : 1;
    if (Object.keys(update).length > 1) await zabbix("host.update", update);

    // IP 는 주 인터페이스(main=1)를 갱신
    if (typeof body.ip === "string" && body.ip.trim()) {
      const hosts = await zabbix<{ interfaces?: { interfaceid: string; main: string }[] }[]>("host.get", {
        hostids: [hostid], output: ["hostid"], selectInterfaces: ["interfaceid", "main"],
      });
      const ifs = hosts[0]?.interfaces ?? [];
      const target = ifs.find((i) => i.main === "1") ?? ifs[0];
      if (!target) return NextResponse.json({ error: "인터페이스가 없어 IP 를 바꿀 수 없습니다" }, { status: 400 });
      await zabbix("hostinterface.update", { interfaceid: target.interfaceid, ip: body.ip.trim() });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

/**
 * DELETE /api/serverroom/host/{hostid}
 * Zabbix 에서 호스트를 삭제한다(수집 이력 포함, 되돌릴 수 없음).
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ hostid: string }> }) {
  const { hostid } = await ctx.params;
  try {
    await zabbix("host.delete", [hostid]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
