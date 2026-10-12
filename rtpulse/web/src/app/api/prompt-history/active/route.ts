import { NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/prompt-history/active
 * 각 고객사에서 현재 사용 중(is_active=true)인 프롬프트 버전 목록 반환
 * Response: { [version]: string[] }  — 버전 → 고객사 이름 배열
 */
export async function GET() {
  try {
    await initDb();
    const { rows } = await getPool().query<{ version: string; customer_name: string }>(`
      SELECT ph.version, c.name AS customer_name
      FROM prompt_history ph
      JOIN customers c ON c.id = ph.customer_id
      WHERE ph.is_active = TRUE
      ORDER BY ph.version
    `);

    // { version: [customerName, ...] } 형태로 변환
    const result: Record<string, string[]> = {};
    for (const row of rows) {
      if (!row.version) continue;
      const v = row.version.toLowerCase(); // 대소문자 통일
      result[v] = [...(result[v] ?? []), row.customer_name];
    }

    return NextResponse.json(result);
  } catch (e) {
    console.error("[prompt-history/active]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
