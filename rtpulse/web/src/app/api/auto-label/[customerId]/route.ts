/**
 * POST /api/auto-label/[customerId]
 *
 * 특정 고객사의 미라벨 이벤트를 즉시 Gemini로 자동 라벨링합니다.
 * 활성화 설정(site_settings)과 무관하게 항상 실행됩니다 (수동 트리거).
 */
import { NextRequest, NextResponse } from "next/server";
import { runAutoLabel } from "@/lib/gemini-auto-label";

export const runtime     = "nodejs";
export const maxDuration = 600; // 10분

type Params = { params: Promise<{ customerId: string }> };

async function handle(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  if (!customerId) return NextResponse.json({ error: "customerId 필요" }, { status: 400 });

  // POST body에서 fileNames / thumbPaths 읽기 (선택된 항목만 처리)
  let fileNames:  string[]                    | undefined;
  let thumbPaths: Record<string, string>      | undefined;
  if (req.method === "POST") {
    try {
      const body = await req.json() as { fileNames?: unknown; thumbPaths?: unknown };
      if (Array.isArray(body?.fileNames) && body.fileNames.length > 0) {
        fileNames = body.fileNames as string[];
      }
      if (body?.thumbPaths && typeof body.thumbPaths === "object" && !Array.isArray(body.thumbPaths)) {
        thumbPaths = body.thumbPaths as Record<string, string>;
      }
    } catch { /* body 없음 또는 파싱 실패 — 전체 처리 */ }
  }

  console.log(`[auto-label/${customerId}] 수동 트리거${fileNames ? ` (${fileNames.length}건 선택)` : " (전체)"}${thumbPaths ? " +thumbPaths" : ""}`);
  try {
    // targetCustomerId + fileNames + thumbPaths 전달
    const summaries = await runAutoLabel(customerId, fileNames, thumbPaths);
    const totalProcessed = summaries.reduce((s, r) => s + r.processed, 0);
    const totalErrors    = summaries.reduce((s, r) => s + r.errors,    0);
    return NextResponse.json({ ok: true, totalProcessed, totalErrors, summaries });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[auto-label/${customerId}] 오류:`, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const GET  = handle;
export const POST = handle;
