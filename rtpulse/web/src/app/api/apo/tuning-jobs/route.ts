import { NextRequest, NextResponse } from "next/server";
import { apoFetch, getApoBaseUrl, toApoMountPath } from "@/lib/apo-backend";

export const runtime = "nodejs";

/**
 * POST /api/apo/tuning-jobs
 * APO 튜닝 작업 시작 + SSE 스트리밍 프록시
 *
 * Body: { savePath, jsonPath, peCategory, minPromptKeep, repeatCount, modelSize }
 * Response: text/event-stream (SSE)
 *
 * APO 백엔드의 SSE 스트림을 그대로 클라이언트에 프록시합니다.
 */
export async function POST(req: NextRequest) {
  try {
    getApoBaseUrl();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // NAS 경로(/rtpulse/...)를 APO 서버 마운트 경로(/mnt/rtpulse/...)로 변환
  if (typeof body.savePath === "string") body.savePath = toApoMountPath(body.savePath);
  if (typeof body.jsonPath === "string") body.jsonPath = toApoMountPath(body.jsonPath);

  let upstream: Response;
  try {
    upstream = await apoFetch("/tuning-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return NextResponse.json(
      { error: `APO 백엔드 연결 실패: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }

  if (!upstream.ok || !upstream.body) {
    // APO 에러 JSON을 그대로 전달 (파싱 실패 시 문자열로 감쌈)
    const errJson = await upstream.json().catch(async () => {
      const t = await upstream.text().catch(() => "알 수 없는 오류");
      return { detail: { ok: false, error: { code: "UNKNOWN", message: t } } };
    });
    return NextResponse.json(errJson, { status: upstream.status });
  }

  // SSE 스트림 프록시: TransformStream으로 upstream body를 그대로 전달
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  // 비동기로 upstream stream → TransformStream 으로 파이프
  (async () => {
    const reader = upstream.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } catch {
      // client disconnect 등 정상 종료 케이스 포함
    } finally {
      writer.close().catch(() => {});
    }
  })();

  return new NextResponse(readable, {
    status: 200,
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
