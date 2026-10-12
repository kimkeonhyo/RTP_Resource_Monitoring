/**
 * Next.js Instrumentation Hook
 * 서버 시작 시 한 번 실행되어 다음 세 가지 주기적 작업을 등록합니다.
 *   1. alert-check     — 1분마다   스트림 상태 모니터링 + Slack 알림
 *   2. auto-label      — 4시간마다 미라벨 이벤트 Gemini 자동 라벨링
 *   3. nas-auto-upload — 1분마다   자동 업로드 활성화 고객사 thumbnail → NAS 백업
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Node.js 전용 API(process.on 등)는 동적 import로 분리 —
  // Turbopack이 Edge Runtime 컴파일 패스에서 이 파일을 분석할 때 process.on 경고가 뜨는 것을 방지
  // (Next.js 공식 권장 패턴: https://nextjs.org/docs/app/guides/instrumentation)
  await import("./instrumentation-node");

  const port = process.env.PORT ?? "3000";
  const base = `http://127.0.0.1:${port}`;

  /* ── 1. Alert Check — 1분마다 ──────────────────────────────────────────── */
  const runAlertCheck = async () => {
    try {
      await fetch(`${base}/api/alert-check`, { method: "POST" });
    } catch {
      // 서버 아직 준비 중이거나 일시적 오류 — 다음 주기에 재시도
    }
  };

  setTimeout(runAlertCheck, 15_000);           // 서버 준비 대기 후 최초 실행
  setInterval(runAlertCheck, 60_000);          // 이후 1분마다

  /* ── 2. Auto-Label — 4시간마다 ─────────────────────────────────────────── */
  // HTTP 셀프 콜 대신 직접 함수 호출 — AbortSignal.timeout 버전 이슈 & 네트워크 불안정 방지
  if (process.env.GOOGLE_AI_STUDIO_API_KEY) {
    const scheduleAutoLabel = async () => {
      console.log("[auto-label] 스케줄 실행 시작");
      try {
        const { runAutoLabel } = await import("./lib/gemini-auto-label");
        const summaries = await runAutoLabel();
        const total  = summaries.reduce((s, r) => s + r.processed, 0);
        const errors = summaries.reduce((s, r) => s + r.errors, 0);
        console.log(`[auto-label] 스케줄 완료: ${total}건 라벨링, 오류 ${errors}건`);
      } catch (e: unknown) {
        console.error("[auto-label] 스케줄 오류:", e instanceof Error ? e.message : String(e));
      }
    };

    const FOUR_HOURS = 4 * 60 * 60 * 1_000;

    setTimeout(scheduleAutoLabel, 60_000);          // 서버 시작 1분 후 최초 실행
    setInterval(scheduleAutoLabel, FOUR_HOURS);     // 이후 4시간마다
  } else {
    console.warn("[auto-label] GOOGLE_AI_STUDIO_API_KEY 미설정 — 오토라벨링 비활성화");
  }

  /* ── 3. NAS Auto-Upload — 1분마다 스케줄 체크 ──────────────────────────── */
  // HTTP self-call 없이 직접 함수 호출 (standalone 모드 405 방지)
  const scheduleNasAutoUpload = async () => {
    try {
      const { runNasAutoUploadSchedule } = await import("./lib/nas-auto-upload");
      await runNasAutoUploadSchedule();
    } catch { /* 무시 */ }
  };

  setTimeout(scheduleNasAutoUpload, 30_000);    // 서버 시작 30초 후 최초 체크
  setInterval(scheduleNasAutoUpload, 60_000);   // 이후 1분마다

  /* ── 4. Prompt Sync — 웹에서 설정한 KST 시각마다 ───────────────────────── */
  // site_settings(prompt_sync_schedule)를 읽어 설정된 시각(HH:MM, KST)에 1회 트리거.
  // 30초 틱 + 분 단위 중복 방지로 각 대상 분에 정확히 1번 실행.
  let lastPromptSyncMinute = "";
  const schedulePromptSync = async () => {
    try {
      const { getSchedule } = await import("./lib/prompt-sync-schedule");
      const sch = await getSchedule();
      if (!sch.enabled || sch.times.length === 0) return;

      // 현재 KST "YYYY-MM-DD HH:MM" (VM이 UTC여도 정확)
      const kst = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date());
      const hhmm = kst.slice(11, 16); // "HH:MM"

      if (sch.times.includes(hhmm) && kst !== lastPromptSyncMinute) {
        lastPromptSyncMinute = kst; // 이 분엔 다시 실행 안 함
        await fetch(`${base}/api/prompt-records?csv=${sch.csv ? 1 : 0}&json=${sch.json ? 1 : 0}`, { method: "POST" });
        console.log(`[prompt-sync] 스케줄 실행 ${hhmm} KST (csv=${sch.csv}, json=${sch.json})`);
      }
    } catch { /* 서버 준비 중/일시 오류 — 다음 틱 재시도 */ }
  };

  setTimeout(schedulePromptSync, 45_000);  // 서버 준비 후 최초 체크
  setInterval(schedulePromptSync, 30_000); // 이후 30초마다 (대상 분 놓치지 않게)
}
