/**
 * Notion 프롬프트 자동 동기화 스케줄 설정 (site_settings 저장).
 * 웹에서 시간(KST HH:MM)·CSV/JSON 옵션·활성화 여부를 편집하고,
 * instrumentation의 30초 틱이 이 설정을 읽어 해당 시각에 동기화를 트리거한다.
 */
import { getPool, initDb } from "@/lib/db";

export interface PromptSyncSchedule {
  enabled: boolean;
  times: string[]; // "HH:MM" (Asia/Seoul 기준), 예: ["08:00","12:00","18:00"]
  csv: boolean;
  json: boolean;
}

const KEY = "prompt_sync_schedule";
export const DEFAULT_SCHEDULE: PromptSyncSchedule = {
  enabled: false,
  times: ["08:00", "12:00", "18:00"],
  csv: true,
  json: true,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 임의 입력을 안전한 스케줄 객체로 정규화(시간 형식 검증·중복제거·정렬). */
export function normalizeSchedule(raw: unknown): PromptSyncSchedule {
  const o = (raw ?? {}) as Partial<PromptSyncSchedule>;
  const times = Array.isArray(o.times)
    ? [...new Set(o.times.filter((t): t is string => typeof t === "string" && TIME_RE.test(t)))].sort()
    : [...DEFAULT_SCHEDULE.times];
  return {
    enabled: o.enabled === true,
    times,
    csv: o.csv !== false, // 기본 true
    json: o.json !== false, // 기본 true
  };
}

export async function getSchedule(): Promise<PromptSyncSchedule> {
  await initDb();
  const { rows } = await getPool().query<{ value: string }>(
    `SELECT value FROM site_settings WHERE key = $1`,
    [KEY],
  );
  if (!rows[0]) return { ...DEFAULT_SCHEDULE };
  try {
    return normalizeSchedule(JSON.parse(rows[0].value));
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

export async function saveSchedule(s: unknown): Promise<PromptSyncSchedule> {
  await initDb();
  const norm = normalizeSchedule(s);
  await getPool().query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [KEY, JSON.stringify(norm), new Date().toISOString()],
  );
  return norm;
}
