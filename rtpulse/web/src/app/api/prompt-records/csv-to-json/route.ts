/**
 * POST /api/prompt-records/csv-to-json
 *
 * CSV 파일을 JSON으로 변환합니다.
 * feature 컬럼이 없을 경우 Flask PE-Core 서버로 프록시합니다.
 *
 * Body: multipart/form-data
 *   - file:          CSV 파일 (required)
 *   - includePrompt: "true" | "false" (optional, default "true")
 *
 * Response: application/json — 변환된 JSON 배열
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const EXTRACTOR_URL = () =>
  (process.env.FEATURE_EXTRACTOR_URL ?? "").replace(/\/$/, "");

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: `multipart 파싱 실패: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 }
    );
  }

  const file = formData.get("file") as File | null;
  const includePrompt = (formData.get("includePrompt") as string | null) !== "false";

  if (!file) {
    return NextResponse.json({ error: "CSV 파일을 선택하세요." }, { status: 400 });
  }

  // ── Flask 서버로 프록시 ────────────────────────────────────────────────────
  const extractorUrl = EXTRACTOR_URL();
  if (!extractorUrl) {
    return NextResponse.json(
      { error: "FEATURE_EXTRACTOR_URL 환경변수가 설정되지 않았습니다. feature 컬럼이 포함된 CSV를 사용하거나 서버 설정을 확인하세요." },
      { status: 500 }
    );
  }

  try {
    // Flask /upload endpoint로 전달
    // output_mode는 업로드 시 폼 필드로 함께 전송 (Flask 명세)
    const upstream = new FormData();
    upstream.append("csv_file", file, file.name);
    upstream.append("output_mode", includePrompt ? "with_prompt" : "no_prompt");

    const uploadRes = await fetch(`${extractorUrl}/upload`, {
      method: "POST",
      body: upstream,
      // 대용량 CSV(수만 행)는 PE-Core 인코딩에 수 분 소요 → 10분으로 상향
      // (Node requestTimeout 30분, Caddy 1200초보다 작아 실제 병목이 되던 값)
      signal: AbortSignal.timeout(600_000),
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      return NextResponse.json(
        { error: `Flask 서버 오류 (${uploadRes.status}): ${text}` },
        { status: 502 }
      );
    }

    const uploadJson = await uploadRes.json() as { download_url?: string; row_count?: number; error?: string };
    if (!uploadJson.download_url) {
      return NextResponse.json(
        { error: `Flask 응답 이상: ${JSON.stringify(uploadJson)}` },
        { status: 502 }
      );
    }

    // 상대 경로 → 절대 URL 변환 (Flask가 "/download/xxx" 형태로 반환)
    const rawDownloadUrl = uploadJson.download_url.startsWith("http")
      ? uploadJson.download_url
      : `${extractorUrl}${uploadJson.download_url}`;

    const jsonRes = await fetch(rawDownloadUrl, {
      signal: AbortSignal.timeout(300_000), // 5분 (대용량 feature 파일 대응)
    });

    if (!jsonRes.ok) {
      return NextResponse.json(
        { error: `JSON 다운로드 실패 (${jsonRes.status})` },
        { status: 502 }
      );
    }

    if (!jsonRes.body) {
      return NextResponse.json({ error: "Flask 응답 body가 비어있습니다." }, { status: 502 });
    }

    // row_count를 헤더로 전달, body는 Flask JSON 배열을 직접 스트리밍
    const rowCount = uploadJson.row_count ?? 0;
    return new NextResponse(jsonRes.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-Row-Count": String(rowCount),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `프록시 오류: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
