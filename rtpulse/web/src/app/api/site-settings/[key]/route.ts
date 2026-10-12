import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";

type Params = { params: Promise<{ key: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { key } = await params;
  try {
    await initDb();
    const { rows } = await getPool().query(
      `SELECT value FROM site_settings WHERE key = $1`,
      [key]
    );
    if (rows.length === 0) return NextResponse.json({ value: null });
    return NextResponse.json({ value: rows[0].value });
  } catch (e) {
    console.error("[site-settings] GET error:", e);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { key } = await params;
  const { value } = (await req.json()) as { value: string };
  if (typeof value !== "string") {
    return NextResponse.json({ error: "value 필드가 필요합니다" }, { status: 400 });
  }
  try {
    await initDb();
    await getPool().query(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, value, new Date().toISOString()]
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[site-settings] PUT error:", e);
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
}
