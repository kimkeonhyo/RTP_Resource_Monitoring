import { NextResponse } from "next/server";
import { zabbix, problemsForHosts, zabbixWebUrl } from "@/lib/zabbix";
import { MAP_NAME, savePositions } from "@/lib/topology";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/serverroom/topology
 *
 * Zabbix 맵을 읽어 그리기 좋은 형태로 돌려준다.
 *
 * 맵 이미지를 그대로 가져오지 않는 이유: Zabbix 프런트엔드의 map.php 는 API 토큰이
 * 아니라 세션 쿠키를 요구하고, 무엇보다 이미지에는 클릭할 곳이 없다. 좌표를 받아
 * 직접 그리면 아이콘마다 watch 호스트 페이지로 보낼 수 있다.
 *
 * 배치는 Zabbix 맵이 원본이다. 구성도를 고칠 때는 Zabbix 화면에서 옮기면 되고
 * 여기 코드는 손댈 필요가 없다.
 */

type ZbxMap = {
  sysmapid: string; name: string; width: string; height: string;
  /** 맵 속성의 '최소 심각도'. 이보다 낮은 문제는 Zabbix 화면에서도 안 보인다. */
  severity_min: string;
  /** 라벨 규칙. 고급 라벨(label_format=1)이 켜져 있으면 요소별 label 을 무시하고
   *  요소 종류별 설정(label_type_host 등)을 쓴다. 이걸 안 따르면 같은 맵인데
   *  Zabbix 와 watch 의 라벨이 갈린다. */
  label_format: string;
  label_type: string;
  label_type_host: string; label_string_host: string;
  label_type_image: string; label_string_image: string;
  selements: {
    selementid: string; elementtype: string; iconid_off: string;
    label: string; label_location: string; x: string; y: string;
    elements: { hostid?: string }[];
  }[];
  links: { selementid1: string; selementid2: string; drawtype: string; color: string; label?: string }[];
  shapes: {
    type: string; x: string; y: string; width: string; height: string; text: string;
    font_size: string; font_color: string; text_halign: string; text_valign: string;
    border_type: string; border_width: string; border_color: string; background_color: string;
  }[];
};

/** PNG 헤더에서 실제 크기를 읽는다. 아이콘마다 64·128px 로 달라서 중심 좌표 계산에 필요하다. */
function pngSize(b64: string): { w: number; h: number } {
  try {
    const b = Buffer.from(b64, "base64");
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch {
    return { w: 64, h: 64 };
  }
}

// 아이콘은 바뀌지 않으므로 프로세스에 남겨 둔다. 매 요청 base64 를 다시 받을 이유가 없다.
const iconCache = new Map<string, { url: string; w: number; h: number }>();

async function icons(ids: string[]) {
  const miss = ids.filter((i) => !iconCache.has(i));
  if (miss.length) {
    const rows = await zabbix<{ imageid: string; image: string }[]>("image.get", {
      imageids: miss, output: ["imageid"], select_image: true,
    });
    for (const r of rows) {
      const { w, h } = pngSize(r.image);
      iconCache.set(r.imageid, { url: `data:image/png;base64,${r.image}`, w, h });
    }
  }
  return iconCache;
}

export type TopoElement = {
  id: string;
  x: number; y: number; w: number; h: number;
  /** icons 사전의 키. 같은 아이콘을 58번 실어 보내지 않으려고 참조만 준다. */
  iconId: string;
  label: string;
  labelLocation: number;
  hostid?: string;
  /** ok | problem | disabled | none(호스트가 아닌 장식용 요소) */
  state: "ok" | "problem" | "disabled" | "none";
  severity: number;
  problems: string[];
};

export type TopoResult = {
  name: string;
  width: number; height: number;
  /** iconId → data URI */
  icons: Record<string, string>;
  severityMin: number;
  elements: TopoElement[];
  /** 끝점은 좌표가 아니라 요소 id 다. 화면에서 끌어 옮기는 동안 선이 따라오려면 좌표를 클라이언트가 계산해야 한다. */
  links: { from: string; to: string; color: string; dash: boolean; bold: boolean; label?: string }[];
  shapes: {
    x: number; y: number; w: number; h: number; text: string;
    fill: string; stroke: string; strokeWidth: number; fontSize: number; fontColor: string;
  }[];
  zabbixWeb: string | null;
  updatedAt: string;
};

export async function GET() {
  try {
    const maps = await zabbix<ZbxMap[]>("map.get", {
      output: "extend", filter: { name: [MAP_NAME] },
      selectSelements: "extend", selectLinks: "extend", selectShapes: "extend",
    });
    if (!maps.length) {
      return NextResponse.json({ error: `Zabbix 에 '${MAP_NAME}' 맵이 없습니다` }, { status: 404 });
    }
    const m = maps[0];

    const hostids = [...new Set(
      m.selements.flatMap((s) => s.elements.map((e) => e.hostid)).filter((x): x is string => !!x),
    )];
    const [hosts, problems, ico] = await Promise.all([
      zabbix<{ hostid: string; name: string; status: string;
               interfaces: { ip: string; main: string }[] }[]>("host.get", {
        output: ["hostid", "name", "status"], hostids,
        selectInterfaces: ["ip", "main"],
      }),
      problemsForHosts(hostids),
      icons([...new Set(m.selements.map((s) => s.iconid_off))]),
    ]);
    const byId = new Map(hosts.map((h) => [h.hostid, h]));
    // {HOST.IP} 는 기본(main) 인터페이스 주소다. 없으면 첫 번째를 쓴다.
    const ipById = new Map(hosts.map((h) => [
      h.hostid,
      (h.interfaces?.find((i) => i.main === "1") ?? h.interfaces?.[0])?.ip ?? "",
    ]));
    // 맵 속성의 '최소 심각도'를 그대로 따른다. 이걸 무시하면 Zabbix 화면에서는 전부
    // 정상인데 watch 에서만 장애가 잔뜩 뜬다 — 지금 맵은 4(높음)로 잡혀 있다.
    const sevMin = Number(m.severity_min) || 0;

    // Zabbix 라벨 규칙을 그대로 옮긴다.
    //   0 = 라벨(고급 라벨에서는 '사용자 지정' — label_string_* 를 쓴다)
    //   1 = IP 주소   2 = 요소 이름   3 = 상태만   4 = 없음
    // 0 과 '사용자 지정'의 enum 값이 버전에 따라 갈려서, label_string 이 비어 있지
    // 않으면 그것을 쓰고 아니면 요소별 label 로 되돌아가게 했다. 어느 쪽이든 화면과 맞는다.
    const expand = (tpl: string, host?: { name: string }, ip?: string) =>
      tpl.replace(/\{HOST\.(NAME|VISIBLE)\}/g, host?.name ?? "")
         .replace(/\{HOST\.(IP|CONN|DNS)\}/g, ip ?? "")
         .replace(/\r\n/g, "\n")
         .trim();

    const advanced = m.label_format === "1";
    const labelFor = (
      s: { elementtype: string; label: string },
      host: { name: string } | undefined,
      ip: string | undefined,
    ): string => {
      const isHost = s.elementtype === "0";
      const type = advanced ? (isHost ? m.label_type_host : m.label_type_image) : m.label_type;
      const custom = advanced ? (isHost ? m.label_string_host : m.label_string_image) : "";
      if (type === "4" || type === "3") return "";          // 없음 / 상태만
      if (type === "1") return ip ?? "";                     // IP 주소
      if (type === "2") return host?.name ?? expand(s.label, host, ip);  // 요소 이름
      return expand(custom || s.label, host, ip);            // 라벨 / 사용자 지정
    };

    const elements: TopoElement[] = m.selements.map((s) => {
      const img = ico.get(s.iconid_off) ?? { url: "", w: 64, h: 64 };
      const hostid = s.elements[0]?.hostid;
      const host = hostid ? byId.get(hostid) : undefined;
      const ps = (hostid ? problems.get(hostid) ?? [] : [])
        .filter((p) => Number(p.severity) >= sevMin);
      const severity = ps.reduce((a, p) => Math.max(a, Number(p.severity)), 0);
      return {
        id: s.selementid,
        x: Number(s.x), y: Number(s.y), w: img.w, h: img.h,
        iconId: s.iconid_off,
        label: labelFor(s, host, hostid ? ipById.get(hostid) : undefined) || host?.name || "",
        labelLocation: Number(s.label_location),
        hostid,
        state: !host ? "none" : host.status === "1" ? "disabled" : ps.length ? "problem" : "ok",
        severity,
        problems: ps.map((p) => p.name),
      };
    });

    const ids = new Set(elements.map((e) => e.id));
    const links = m.links
      .filter((l) => ids.has(l.selementid1) && ids.has(l.selementid2))
      .map((l) => ({
        from: l.selementid1, to: l.selementid2,
        color: `#${l.color}`,
        dash: l.drawtype === "4" || l.drawtype === "3",
        bold: l.drawtype === "2",
        ...(l.label ? { label: l.label } : {}),
      }));

    const shapes = m.shapes.map((s) => ({
      x: Number(s.x), y: Number(s.y), w: Number(s.width), h: Number(s.height),
      text: s.text,
      fill: `#${s.background_color || "FFFFFF"}`,
      stroke: s.border_type === "0" ? "none" : `#${s.border_color || "CCCCCC"}`,
      strokeWidth: Number(s.border_width) || 1,
      fontSize: Number(s.font_size) || 12,
      fontColor: `#${s.font_color || "4A4A4A"}`,
    }));

    return NextResponse.json({
      name: m.name, width: Number(m.width), height: Number(m.height),
      icons: Object.fromEntries([...new Set(m.selements.map((s) => s.iconid_off))]
        .map((id) => [id, ico.get(id)?.url ?? ""])),
      severityMin: sevMin,
      elements, links, shapes,
      zabbixWeb: zabbixWebUrl(),
      updatedAt: new Date().toISOString(),
    } satisfies TopoResult);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

/**
 * POST /api/serverroom/topology
 *
 * 화면에서 끌어 옮긴 좌표를 Zabbix 맵에 저장한다. 옮긴 것만 보내면 된다.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const moved = body?.positions;
    if (!Array.isArray(moved) || moved.some((p) => !p?.id || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      return NextResponse.json({ error: "positions 형식이 올바르지 않습니다" }, { status: 400 });
    }
    const n = await savePositions(moved);
    return NextResponse.json({ saved: n });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
