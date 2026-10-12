/**
 * Notion 프롬프트 동기화 백그라운드 작업 상태 (단일 인스턴스 인메모리 싱글턴).
 *
 * 동기화는 항목마다 HF CSV 다운로드 + Flask 변환(느림) + NAS 업로드를 하므로
 * 긴 HTTP 요청/스트리밍으로 처리하면 LB·프록시 타임아웃에 걸린다.
 * 대신 POST가 이 작업을 백그라운드로 띄우고 즉시 반환하며, 프런트는 상태를
 * 폴링한다. 앱은 단일 Next.js 인스턴스라 모듈 전역 상태로 충분하다.
 */
export interface SyncResult { version: string; action: "done" | "failed" | "skip"; detail?: string; reason?: string }
export interface SyncCounts { inserted: number; updated: number; uploaded: number; skipped: number }
export interface SyncJob {
  running: boolean;
  total: number;
  index: number;
  version: string;
  counts: SyncCounts;
  results: SyncResult[];
  error: string | null;
  options: { csv: boolean; json: boolean };
  startedAt: number | null;
  finishedAt: number | null;
}

function emptyJob(): SyncJob {
  return {
    running: false, total: 0, index: 0, version: "",
    counts: { inserted: 0, updated: 0, uploaded: 0, skipped: 0 },
    results: [], error: null, options: { csv: true, json: true },
    startedAt: null, finishedAt: null,
  };
}

let job: SyncJob = emptyJob();

export function getSyncJob(): SyncJob { return job; }
export function isSyncRunning(): boolean { return job.running; }

/** 새 작업 시작 — 상태 초기화 후 running=true. */
export function beginSyncJob(options: { csv: boolean; json: boolean }): void {
  job = { ...emptyJob(), running: true, options, startedAt: Date.now() };
}

/** 진행 상태 갱신(results 배열은 유지). */
export function patchSyncJob(p: Partial<Omit<SyncJob, "results">>): void {
  job = { ...job, ...p };
}

export function pushSyncResult(r: SyncResult): void {
  job.results.push(r);
}

/** 작업 종료 — running=false. */
export function finishSyncJob(p: Partial<Omit<SyncJob, "results" | "running" | "finishedAt">>): void {
  job = { ...job, ...p, running: false, finishedAt: Date.now() };
}
