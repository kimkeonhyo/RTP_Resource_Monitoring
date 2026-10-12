/**
 * VMS Release Notes(Notion)에서 이미지별 버전 목록을 조회한다.
 *
 * IMS(notion-catalog)과 동일한 소스·매핑을 사용한다:
 *   VMS Release Notes 페이지의 컴포넌트별 릴리즈 DB(FE/BE/ES/MEDIA)의
 *   각 행 제목(Name, 예: "vms-be-event-v26.03.20")이 곧 버전 문자열이다.
 *   이미지 → DB + 이름 필터 키워드 매핑으로 이미지별 버전 목록을 만든다.
 *
 * watch의 기존 Notion 연동과 동일하게 NOTION_API_KEY + REST(v2022-06-28)를 쓴다.
 * NOTION_API_KEY 미설정/DB 미공유 시 빈 결과를 반환한다(호출측에서 폴백).
 */

const NOTION_API_KEY = () => process.env.NOTION_API_KEY ?? "";
const NOTION_VERSION = "2022-06-28";

// VMS Release Notes 컴포넌트 릴리즈 DB
const DB_FE    = process.env.NOTION_DB_FE    ?? "";
const DB_BE    = process.env.NOTION_DB_BE    ?? "";
const DB_ES    = process.env.NOTION_DB_ES    ?? "";
const DB_MEDIA = process.env.NOTION_DB_MEDIA ?? "";

// 이미지(소문자) → 릴리즈 DB + 이름 필터 키워드 (IMS IMAGE_SPECS와 동일)
const IMAGE_SPECS: { image: string; db: string; match?: string }[] = [
  { image: "frontend",    db: DB_FE },
  { image: "api-gateway", db: DB_BE, match: "api-gateway" },
  { image: "auth",        db: DB_BE, match: "auth" },
  { image: "camera",      db: DB_BE, match: "camera" },
  { image: "event",       db: DB_BE, match: "event" },
  { image: "inference",   db: DB_ES, match: "inference" },
  { image: "decoder",     db: DB_ES, match: "decoder" },
  { image: "es-gateway",  db: DB_ES, match: "gateway" },
  { image: "mediamtx",    db: DB_MEDIA, match: "mediamtx" },
];

// 번들 릴리즈 DB + 구성 컴포넌트 컬럼 (IMS notion-catalog와 동일)
const DB_BUNDLE = process.env.NOTION_DB_BUNDLE ?? "";
const BUNDLE_COMPONENT_COLS = [
  "Frontend", "API Gateway", "Auth", "Camera", "Event",
  "Inference", "Decoder", "Transcode", "Gateway", "MediaMTX",
];

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { ts: number; data: Record<string, string[]> } | null = null;
let bundleCache: { ts: number; data: VmsBundle[] } | null = null;

export interface VmsBundle {
  name: string;                        // 번들 버전 (예: R-26.06.1)
  appliedSites: string[];              // 적용 사이트
  components: Record<string, string>;  // 구성 컴포넌트별 버전 (Frontend/API Gateway/…)
}

/** 페이지의 title 타입 속성 값(plain text)을 추출 */
function extractTitle(props: Record<string, { type?: string; title?: { plain_text: string }[] }>): string {
  for (const p of Object.values(props)) {
    if (p?.type === "title" && Array.isArray(p.title)) {
      return p.title.map((t) => t.plain_text ?? "").join("").trim();
    }
  }
  return "";
}

/** DB의 행 제목(Name) 목록을 조회 (페이지네이션, 상한) */
async function queryDbTitles(dbId: string): Promise<string[]> {
  const key = NOTION_API_KEY();
  if (!key) return [];
  const titles: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  const MAX_PAGES = 4;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Notion ${dbId} query ${res.status}`);
    const data = await res.json() as { results: { properties: Record<string, { type?: string; title?: { plain_text: string }[] }> }[]; has_more: boolean; next_cursor: string | null };
    for (const row of data.results ?? []) {
      const name = extractTitle(row.properties ?? {});
      if (name && !seen.has(name)) { seen.add(name); titles.push(name); }
    }
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
    pages += 1;
  } while (cursor && pages < MAX_PAGES);
  return titles;
}

/** 이미지(소문자) → 버전 목록. 실패 시 빈 객체. 5분 캐시. */
export async function getVmsImageVersionOptions(): Promise<Record<string, string[]>> {
  if (!NOTION_API_KEY()) return {};
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;

  const uniqueDbs = [...new Set(IMAGE_SPECS.map((s) => s.db))];
  const titlesByDb: Record<string, string[]> = {};
  for (const db of uniqueDbs) titlesByDb[db] = await queryDbTitles(db);

  const out: Record<string, string[]> = {};
  for (const spec of IMAGE_SPECS) {
    const all = titlesByDb[spec.db] ?? [];
    let versions = all;
    if (spec.match) {
      const kw = spec.match.toLowerCase();
      const filtered = all.filter((n) => n.toLowerCase().includes(kw));
      // 키워드가 실제 DB 네이밍과 안 맞아 비면(예: BE=backend/socket/cron) 해당
      // 컴포넌트 DB 전체 목록으로 폴백 — 드롭다운이 비지 않도록.
      versions = filtered.length > 0 ? filtered : all;
    }
    out[spec.image] = versions;
  }
  cache = { ts: Date.now(), data: out };
  return out;
}

// ─── 번들 목록 (배포 방식 BUNDLE용) ────────────────────────────────────────────

function extractRichText(prop?: { type?: string; rich_text?: { plain_text: string }[] }): string {
  if (prop?.type === "rich_text" && Array.isArray(prop.rich_text)) {
    return prop.rich_text.map((t) => t.plain_text ?? "").join("").trim();
  }
  return "";
}
function extractMultiSelect(prop?: { type?: string; multi_select?: { name: string }[] }): string[] {
  if (prop?.type === "multi_select" && Array.isArray(prop.multi_select)) {
    return prop.multi_select.map((o) => o.name).filter(Boolean);
  }
  return [];
}

/** 번들 목록(이름·적용사이트·구성 컴포넌트 버전). 실패 시 빈 배열. 5분 캐시. */
export async function getVmsBundles(): Promise<VmsBundle[]> {
  const key = NOTION_API_KEY();
  if (!key) return [];
  if (bundleCache && Date.now() - bundleCache.ts < CACHE_TTL_MS) return bundleCache.data;

  type Prop = { type?: string; title?: { plain_text: string }[]; rich_text?: { plain_text: string }[]; multi_select?: { name: string }[] };
  const rows: { properties: Record<string, Prop>; created_time?: string }[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const MAX_PAGES = 4;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB_BUNDLE}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor, sorts: [{ timestamp: "created_time", direction: "descending" }] }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Notion bundle query ${res.status}`);
    const data = await res.json() as { results: typeof rows; has_more: boolean; next_cursor: string | null };
    rows.push(...(data.results ?? []));
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
    pages += 1;
  } while (cursor && pages < MAX_PAGES);

  const bundles: VmsBundle[] = rows.map((row) => {
    const props = row.properties ?? {};
    const components: Record<string, string> = {};
    for (const col of BUNDLE_COMPONENT_COLS) {
      const v = extractRichText(props[col]);
      if (v) components[col] = v;
    }
    return {
      name: extractTitle(props),
      appliedSites: extractMultiSelect(props["Applied Sites"]),
      components,
    };
  }).filter((b) => b.name);

  bundleCache = { ts: Date.now(), data: bundles };
  return bundles;
}
