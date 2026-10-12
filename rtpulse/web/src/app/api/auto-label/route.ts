/**
 * POST /api/auto-label
 *
 * 모든 고객사의 미라벨 이벤트를 Gemini API로 자동 판단합니다.
 * instrumentation.ts에서 4시간마다 자동 호출됩니다.
 * GET 요청으로 수동 트리거도 가능합니다.
 *
 * 응답: { ok: true, summaries: CustomerLabelSummary[] }
 */
import { NextResponse } from "next/server";
import { runAutoLabel } from "@/lib/gemini-auto-label";

export const runtime    = "nodejs";
export const maxDuration = 600; // 10분 (대용량 배치 처리)

async function handle() {
  console.log("[auto-label] 오토라벨링 시작");
  try {
    const summaries = await runAutoLabel();
    const totalProcessed = summaries.reduce((s, r) => s + r.processed, 0);
    const totalErrors    = summaries.reduce((s, r) => s + r.errors,    0);

    return NextResponse.json({ ok: true, totalProcessed, totalErrors, summaries });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[auto-label] 치명적 오류:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const GET  = handle;
export const POST = handle;
