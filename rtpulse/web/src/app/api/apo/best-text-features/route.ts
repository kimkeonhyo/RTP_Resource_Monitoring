import { NextResponse } from "next/server";
import { apoFetch, getApoBaseUrl } from "@/lib/apo-backend";

export const runtime = "nodejs";

/**
 * GET /api/apo/best-text-features
 * 최적 텍스트 피처 JSON 파일 다운로드 → APO 백엔드의 GET /best-text-features 프록시
 *
 * Response: JSON 파일 (Content-Disposition: attachment)
 */
export async function GET() {
  try {
    getApoBaseUrl();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }

  let upstream: Response;
  try {
    upstream = await apoFetch("/best-text-features", { method: "GET" });
  } catch (e) {
    return NextResponse.json(
      { error: `APO 백엔드 연결 실패: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "알 수 없는 오류");
    return NextResponse.json(
      { error: `APO 백엔드 오류 (${upstream.status}): ${errText}` },
      { status: upstream.status }
    );
  }

  const blob = await upstream.arrayBuffer();

  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="Best_text_features.json"',
    },
  });
}
