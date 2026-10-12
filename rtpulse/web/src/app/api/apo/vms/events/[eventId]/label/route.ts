import { NextRequest, NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { withVmsDb, type VmsDbConn } from "@/lib/vms-db";

export const runtime = "nodejs";

/**
 * PATCH /api/apo/vms/events/[eventId]/label
 * VMS MySQL DB의 copy_camera_events 라벨 직접 업데이트
 *
 * Body: { conn, result, label_name }
 * Response: { ok }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await params;
  if (!eventId) {
    return NextResponse.json({ error: "eventId is required" }, { status: 400 });
  }

  const body = await req.json() as {
    conn:        VmsDbConn;
    result?:     string;
    label_name?: string;
    isWatched?:  boolean;
  };

  const { conn, result, label_name, isWatched } = body;
  if (!conn?.host || !conn?.user || !conn?.dbName) {
    return NextResponse.json({ error: "conn (host, user, dbName) required" }, { status: 400 });
  }

  try {
    await withVmsDb(conn, async (db) => {
      // 실제 컬럼 확인 후 존재하는 컬럼만 업데이트
      const [colRows] = await db.query<RowDataPacket[]>(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'copy_camera_events'",
        [conn.dbName]
      );
      const cols = new Set((colRows as RowDataPacket[]).map((r) => r.COLUMN_NAME as string));

      const sets: string[] = [];
      const vals: (string | null)[] = [];

      // label_name = 클래스(검수 시 지정한 실제 이벤트명). 튜닝이 이 값으로 필터함.
      if (cols.has("label_name") && label_name !== undefined) { sets.push("label_name = ?"); vals.push(label_name ?? null); }
      // 판정(TP/FP)은 result 컬럼(구 스키마)에만 저장. 없으면 조회 시 event_name↔label_name 로 유도.
      if (cols.has("result")     && result     !== undefined) { sets.push("result = ?");     vals.push(result ?? null); }
      if (cols.has("auto_labeling"))   sets.push("auto_labeling = NULL"); // 수동 라벨 → 오토 아님
      if (cols.has("is_watched") && isWatched) sets.push("is_watched = 1");
      if (cols.has("updated_at"))      sets.push("updated_at = NOW()");

      if (sets.length === 0) return;
      await db.query(
        `UPDATE copy_camera_events SET ${sets.join(", ")} WHERE _id = ?`,
        [...vals, eventId]
      );
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
