/**
 * Node.js 런타임 전용 초기화 모듈
 *
 * instrumentation.ts에서 NEXT_RUNTIME === 'nodejs' 조건 하에 동적 import됩니다.
 * Turbopack이 Edge Runtime 컴파일 패스에서 이 파일을 분석하지 않으므로
 * process.on 등 Node.js 전용 API를 경고 없이 사용할 수 있습니다.
 */

// dynamic import()는 ES 모듈만 가능하므로 export 선언 필수
export {};

// 프로세스 전역 에러 핸들러 — 미등록 시 unhandled error → 프로세스 크래시
process.on("uncaughtException", (err: Error) => {
  console.error("[process] uncaughtException:", err.message, err.stack);
  // 크래시 방지: 로그 후 계속 실행 (치명적 오류는 별도 판단)
});

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[process] unhandledRejection:", String(reason));
});
