/**
 * Zabbix 맵(토폴로지) 쓰기 담당.
 *
 * 배치의 원본은 Zabbix 맵이다. watch 는 그것을 그리고, 여기서 두 가지만 되돌려 쓴다.
 *   · 화면에서 끌어 옮긴 좌표 저장
 *   · 새로 등록한 장비를 맵에 추가
 *
 * map.update 규칙 두 가지를 실측으로 확인했다 (2026-09-09).
 *   · selements 를 보내면 목록에 없는 요소는 지워진다. 기존 요소는
 *     {selementid, x, y} 만 보내도 나머지 속성이 유지된다.
 *   · links 를 보낼 때 linkid 를 같이 주면 "Wrong fields for map link" 로 거부한다.
 *     기존 선도 끝점·색을 그대로 다시 보내야 한다.
 */
import { zabbix } from "@/lib/zabbix";

export const MAP_NAME = process.env.ZABBIX_TOPOLOGY_MAP ?? "IMS 인프라 토폴로지";

type Selement = {
  selementid: string; x: string; y: string;
  elements: { hostid?: string }[];
};
type Link = {
  selementid1: string; selementid2: string; drawtype: string; color: string; label?: string;
};
type Shape = { y: string; height: string };
type MapRow = {
  sysmapid: string; width: string; height: string;
  selements: Selement[]; links: Link[]; shapes: Shape[];
};

async function getMap(): Promise<MapRow> {
  const r = await zabbix<MapRow[]>("map.get", {
    output: ["sysmapid", "width", "height"], filter: { name: [MAP_NAME] },
    selectSelements: ["selementid", "x", "y", "elements"],
    selectLinks: ["selementid1", "selementid2", "drawtype", "color", "label"],
    selectShapes: ["y", "height"],
  });
  if (!r.length) throw new Error(`Zabbix 에 '${MAP_NAME}' 맵이 없습니다`);
  return r[0];
}

/** 선을 그대로 되돌려 보내기 위한 형태. linkid 는 빼야 한다. */
const asLink = (l: Link) => ({
  selementid1: l.selementid1, selementid2: l.selementid2,
  drawtype: l.drawtype, color: l.color,
  ...(l.label ? { label: l.label } : {}),
});

/** 화면에서 끌어 옮긴 좌표를 맵에 반영한다. 옮기지 않은 요소는 원래 값 그대로 보낸다. */
export async function savePositions(moved: { id: string; x: number; y: number }[]): Promise<number> {
  if (!moved.length) return 0;
  const m = await getMap();
  const by = new Map(moved.map((p) => [p.id, p]));
  const known = m.selements.filter((s) => by.has(s.selementid));
  if (known.length !== moved.length) {
    throw new Error("맵에 없는 요소가 섞여 있습니다. 새로고침 후 다시 시도하세요");
  }
  await zabbix("map.update", {
    sysmapid: m.sysmapid,
    selements: m.selements.map((s) => {
      const p = by.get(s.selementid);
      return { selementid: s.selementid, x: Math.round(p?.x ?? Number(s.x)), y: Math.round(p?.y ?? Number(s.y)) };
    }),
  });
  return moved.length;
}

// 장비유형 → 아이콘. image.get(imagetype=1) 의 imageid 다.
const ICON: Record<string, string> = {
  server: "102",       // Rackmountable_2U_server_3D_(64)
  workstation: "180",  // Workstation_(64)
  cloud: "150",        // Server_(64)
  router: "125",       // Router_(64)
  switch: "155",       // Switch_(64)
  ap: "145",           // Satellite_antenna_(64)
};

// 장비유형 → 어디에 물리는가. 실제 구성도와 같은 규칙이다.
const UPLINK: Record<string, string> = {
  server: "sw-core",
  workstation: "sw-access",
  cloud: "tsr",
  router: "sw-core",
  switch: "sw-core",
  ap: "sw-office",
};

const SLOT_W = 140;
const SLOT_H = 110;

export type TopologyAdd = { added: boolean; reason?: string; linkedTo?: string };

/**
 * 새로 등록한 장비를 맵에 얹는다.
 *
 * 위치는 모든 그룹 박스 아래의 '미배치' 줄이다. 박스 안 빈자리를 찾아 넣으면
 * 엉뚱한 그룹에 들어갈 수 있고, 어차피 사람이 보고 옮겨야 한다. 아래에 모아 두면
 * 새로 들어온 게 뭔지 한눈에 보이고 화면에서 끌어다 놓으면 된다.
 */
export async function addHostToMap(hostid: string, kind: string): Promise<TopologyAdd> {
  const m = await getMap();
  if (m.selements.some((s) => s.elements.some((e) => e.hostid === hostid))) {
    return { added: false, reason: "이미 맵에 있습니다" };
  }

  // 박스(그룹 사각형) 아래로 내려간다. 박스가 없으면 맵 아래쪽.
  const boxBottom = m.shapes.reduce((a, s) => Math.max(a, Number(s.y) + Number(s.height)), 0);
  const top = Math.max(boxBottom + 30, 40);

  const taken = m.selements.map((s) => ({ x: Number(s.x), y: Number(s.y) }));
  const free = (x: number, y: number) =>
    !taken.some((t) => Math.abs(t.x - x) < SLOT_W && Math.abs(t.y - y) < SLOT_H);

  const cols = Math.max(1, Math.floor((Number(m.width) - 80) / SLOT_W));
  let spot: { x: number; y: number } | null = null;
  for (let row = 0; row < 20 && !spot; row++) {
    for (let col = 0; col < cols; col++) {
      const x = 40 + col * SLOT_W, y = top + row * SLOT_H;
      if (free(x, y)) { spot = { x, y }; break; }
    }
  }
  if (!spot) return { added: false, reason: "맵에 빈자리가 없습니다" };

  await zabbix("map.update", {
    sysmapid: m.sysmapid,
    // 맵이 새 줄만큼 짧으면 늘려 준다. 안 그러면 요소가 캔버스 밖에 놓인다.
    height: Math.max(Number(m.height), spot.y + SLOT_H),
    selements: [
      ...m.selements.map((s) => ({ selementid: s.selementid, x: s.x, y: s.y })),
      {
        elementtype: 0, elements: [{ hostid }],
        iconid_off: ICON[kind] ?? ICON.server,
        x: spot.x, y: spot.y, label: "{HOST.NAME}", label_location: 0,
      },
    ],
  });

  // 새 요소의 selementid 는 만들고 나서야 알 수 있어 선은 두 번째 호출로 건다.
  const after = await getMap();
  const created = after.selements.find((s) => s.elements.some((e) => e.hostid === hostid));
  const uplinkHost = UPLINK[kind];
  if (!created || !uplinkHost) return { added: true };

  const up = await zabbix<{ hostid: string }[]>("host.get", {
    output: ["hostid"], filter: { host: [uplinkHost] },
  });
  const upEl = up.length
    ? after.selements.find((s) => s.elements.some((e) => e.hostid === up[0].hostid))
    : undefined;
  if (!upEl) return { added: true };

  await zabbix("map.update", {
    sysmapid: m.sysmapid,
    links: [
      ...after.links.map(asLink),
      { selementid1: upEl.selementid, selementid2: created.selementid, drawtype: 0, color: "8AA4C8" },
    ],
  });
  return { added: true, linkedTo: uplinkHost };
}
