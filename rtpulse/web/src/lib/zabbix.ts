/**
 * Zabbix API 클라이언트
 *
 * 환경변수:
 *   ZABBIX_URL   예: http://<ZABBIX_SERVER_IP>  (api_jsonrpc.php 는 붙이지 않는다)
 *   ZABBIX_TOKEN API 토큰 (권장). 없으면 ZABBIX_USER/ZABBIX_PASS 로 로그인한다.
 *
 * 서버 컴포넌트·API 라우트 전용이다. 토큰이 클라이언트로 넘어가면 안 된다.
 */

type JsonRpc<T> = { result?: T; error?: { code: number; message: string; data?: string } };

function baseUrl(): string {
  const url = process.env.ZABBIX_URL;
  if (!url) throw new Error("ZABBIX_URL 환경변수가 설정되지 않았습니다.");
  return url.replace(/\/$/, "");
}

// 사용자/비밀번호 로그인 시 세션 토큰을 재사용한다 (매 요청 로그인하면 감사 로그가 오염된다)
let cachedSession: { token: string; at: number } | null = null;
const SESSION_TTL = 30 * 60_000;

async function rpc<T>(method: string, params: unknown, auth?: string): Promise<T> {
  const res = await fetch(`${baseUrl()}/api_jsonrpc.php`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json-rpc",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Zabbix HTTP ${res.status}`);
  const json = (await res.json()) as JsonRpc<T>;
  if (json.error) throw new Error(`${method}: ${json.error.data ?? json.error.message}`);
  return json.result as T;
}

async function authToken(): Promise<string> {
  const token = process.env.ZABBIX_TOKEN;
  if (token) return token;

  if (cachedSession && Date.now() - cachedSession.at < SESSION_TTL) return cachedSession.token;
  const user = process.env.ZABBIX_USER ?? "Admin";
  const password = process.env.ZABBIX_PASS;
  if (!password) throw new Error("ZABBIX_TOKEN 또는 ZABBIX_PASS 가 필요합니다.");
  const t = await rpc<string>("user.login", { username: user, password });
  cachedSession = { token: t, at: Date.now() };
  return t;
}

export async function zabbix<T>(method: string, params: unknown): Promise<T> {
  return rpc<T>(method, params, await authToken());
}

export function zabbixWebUrl(): string | null {
  return process.env.ZABBIX_URL ? baseUrl() : null;
}

// ── 도메인 헬퍼 ───────────────────────────────────────────────────────────────

export type ZbxHost = {
  hostid: string;
  host: string;
  name: string;
  status: string;
  interfaces?: { type: string; ip: string; dns: string; available: string }[];
};

export type ZbxItem = {
  itemid: string;
  hostid: string;
  name: string;
  lastvalue: string;
  lastclock: string;
  units: string;
};

export type ZbxProblem = { eventid: string; objectid: string; name: string; severity: string; clock: string };

export async function hostsInGroups(names: string[]): Promise<ZbxHost[]> {
  const groups = await zabbix<{ groupid: string }[]>("hostgroup.get", {
    output: ["groupid"], filter: { name: names },
  });
  if (groups.length === 0) return [];
  return zabbix<ZbxHost[]>("host.get", {
    output: ["hostid", "host", "name", "status"],
    groupids: groups.map((g) => g.groupid),
    selectInterfaces: ["type", "ip", "dns", "available"],
    sortfield: "name",
  });
}

/** 지정한 호스트들의 최신 값. 아이템 이름으로 거른다(키는 템플릿마다 달라 이름이 안정적이다). */
export async function latestByName(hostids: string[], names: string[]): Promise<ZbxItem[]> {
  if (hostids.length === 0) return [];
  return zabbix<ZbxItem[]>("item.get", {
    output: ["itemid", "hostid", "name", "lastvalue", "lastclock", "units"],
    hostids,
    filter: { name: names, status: 0 },
    webitems: false,
  });
}

/** 이름이 특정 문자열로 시작하는 아이템 (GPU 0 (...): 온도 처럼 장치별로 이름이 다른 경우) */
export async function latestByPrefix(hostids: string[], prefix: string): Promise<ZbxItem[]> {
  if (hostids.length === 0) return [];
  return zabbix<ZbxItem[]>("item.get", {
    output: ["itemid", "hostid", "name", "lastvalue", "lastclock", "units"],
    hostids,
    search: { name: prefix },
    startSearch: true,
    filter: { status: 0 },
  });
}

export type ZbxItemFull = ZbxItem & { value_type: string };

/** 한 호스트의 모든 활성 아이템(값 타입 포함) — 상세 그래프 대상 선별용 */
export async function itemsForHost(hostid: string): Promise<ZbxItemFull[]> {
  return zabbix<ZbxItemFull[]>("item.get", {
    output: ["itemid", "hostid", "name", "lastvalue", "lastclock", "units", "value_type"],
    hostids: [hostid], filter: { status: 0 }, webitems: false, sortfield: "name",
  });
}

export type ZbxHist = { itemid: string; clock: string; value: string };

/** history.get — value_type(0=float,3=uint) 별로 나눠 호출해야 한다 */
export async function historyGet(itemids: string[], valueType: number, timeFrom: number): Promise<ZbxHist[]> {
  if (itemids.length === 0) return [];
  return zabbix<ZbxHist[]>("history.get", {
    output: "extend", history: valueType, itemids, time_from: timeFrom,
    sortfield: "clock", sortorder: "ASC", limit: 20000,
  });
}

export async function hostById(hostid: string): Promise<ZbxHost | null> {
  const hosts = await zabbix<ZbxHost[]>("host.get", {
    output: ["hostid", "host", "name", "status"],
    hostids: [hostid], selectInterfaces: ["type", "ip", "dns", "available"],
  });
  return hosts[0] ?? null;
}

/** 이름에 특정 문자열을 포함하는 아이템(부분일치). 트래픽("...: Bits received/sent")처럼 인터페이스별로 이름이 다를 때. */
export async function latestContains(hostids: string[], substr: string): Promise<ZbxItem[]> {
  if (hostids.length === 0) return [];
  return zabbix<ZbxItem[]>("item.get", {
    output: ["itemid", "hostid", "name", "lastvalue", "lastclock", "units"],
    hostids, search: { name: substr }, filter: { status: 0 },
  });
}

export async function problemsForHosts(hostids: string[]): Promise<Map<string, ZbxProblem[]>> {
  const out = new Map<string, ZbxProblem[]>();
  if (hostids.length === 0) return out;
  const problems = await zabbix<ZbxProblem[]>("problem.get", {
    output: ["eventid", "objectid", "name", "severity", "clock"],
    hostids, recent: false,
  });
  if (problems.length === 0) return out;
  // problem 은 트리거를 가리키므로 호스트를 따로 조회해 매핑한다
  const triggers = await zabbix<{ triggerid: string; hosts: { hostid: string }[] }[]>("trigger.get", {
    output: ["triggerid"], triggerids: [...new Set(problems.map((p) => p.objectid))],
    selectHosts: ["hostid"],
  });
  const trigHost = new Map(triggers.map((t) => [t.triggerid, t.hosts[0]?.hostid]));
  for (const p of problems) {
    const hid = trigHost.get(p.objectid);
    if (!hid) continue;
    if (!out.has(hid)) out.set(hid, []);
    out.get(hid)!.push(p);
  }
  return out;
}
