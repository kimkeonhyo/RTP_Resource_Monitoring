import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/apo/db-info
 * APO 백엔드에 제공할 Watch DB 접속 정보 (password 제외)
 */
export async function GET() {
  return NextResponse.json({
    host:   process.env.DB_HOST ?? "localhost",
    port:   process.env.DB_PORT ?? "5432",
    dbName: process.env.DB_NAME ?? "rtpulse",
    user:   process.env.DB_USER ?? "",
    // password는 보안상 노출하지 않음 — APO 백엔드에서 별도 환경변수 사용
  });
}
