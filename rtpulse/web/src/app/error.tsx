"use client";

/**
 * 라우트 세그먼트 에러 바운더리.
 *
 * 서버/클라이언트 렌더 중 예외가 나도 브라우저의 "This page couldn't load"
 * (빈 화면) 대신 안내 UI를 보여준다. 에러 digest는 서버 로그와 대조용.
 */
import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // 클라이언트 콘솔에도 남겨 진단을 돕는다.
    console.error("[route-error]", error);
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md w-full rounded-xl border border-line bg-input/40 p-6 space-y-4 text-center">
        <div className="text-3xl">⚠️</div>
        <h1 className="text-base font-semibold text-ink">페이지를 불러오지 못했습니다</h1>
        <p className="text-xs text-muted leading-relaxed">
          이 화면을 표시하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.
          문제가 계속되면 아래 오류 코드와 함께 담당자에게 알려주세요.
        </p>
        {error?.digest && (
          <p className="text-[11px] font-mono text-faint">오류 코드: {error.digest}</p>
        )}
        {error?.message && (
          <pre className="text-left text-[11px] font-mono text-amber-300/90 bg-panel border border-line rounded-lg px-3 py-2 max-h-40 overflow-auto whitespace-pre-wrap">{error.message}</pre>
        )}
        <div className="flex items-center justify-center gap-2 pt-1">
          <button
            onClick={reset}
            className="px-3 py-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded-lg transition-colors"
          >
            다시 시도
          </button>
          <a
            href="/"
            className="px-3 py-1.5 text-xs bg-input border border-line2 text-ink2 rounded-lg hover:bg-gray-700 transition-colors"
          >
            홈으로
          </a>
        </div>
      </div>
    </div>
  );
}
