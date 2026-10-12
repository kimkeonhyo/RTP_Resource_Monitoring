import { NextRequest, NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { withVmsDb, type VmsDbConn } from "@/lib/vms-db";
import {
  resolveMinioClient, readMinioObject, classifyWithGemini, parseThumbnailKey,
} from "@/lib/gemini-auto-label";

export const runtime = "nodejs";

/**
 * POST /api/apo/vms/auto-label
 * VMS MySQL copy_camera_events 의 미라벨 이벤트를 Gemini로 오토라벨링.
 *
 * Body: { conn, limit?, eventName?, cameraId?, startDate?, endDate? }
 * Response: { ok, total, processed, tp, fp, tn, fn, errors }
 *
 * 각 이벤트의 thumbnail 을 고객 MinIO(conn.host)에서 읽어 분류 → result/label_name/auto_labeling 갱신.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    conn:       VmsDbConn;
    limit?:     number;
    eventName?: string;
    cameraId?:  string;
    startDate?: string;
    endDate?:   string;
  };
  const { conn, eventName, cameraId, startDate, endDate } = body;
  const limit = Math.min(200, Math.max(1, body.limit ?? 100));

  if (!conn?.host || !conn?.user || !conn?.dbName) {
    return NextResponse.json({ error: "conn (host, user, dbName) required" }, { status: 400 });
  }

  const minioKey    = process.env.MINIO_ACCESS_KEY ?? "";
  const minioSecret = process.env.MINIO_SECRET_KEY ?? "";
  if (!minioKey || !minioSecret) {
    return NextResponse.json({ error: "MINIO_ACCESS_KEY / MINIO_SECRET_KEY 환경변수 미설정" }, { status: 500 });
  }

  try {
    return await withVmsDb(conn, async (db) => {
      const [colRows] = await db.query<RowDataPacket[]>(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'copy_camera_events'",
        [conn.dbName],
      );
      const cols = new Set((colRows as RowDataPacket[]).map((r) => r.COLUMN_NAME as string));
      if (cols.size === 0) {
        return NextResponse.json({ error: `'${conn.dbName}' DB에 copy_camera_events 테이블이 없습니다.` }, { status: 404 });
      }
      // label_name = 클래스(falldown/fire/smoke/normal). 튜닝은 이 값으로 필터함.
      if (!cols.has("label_name")) {
        return NextResponse.json({ error: "copy_camera_events 에 label_name 컬럼이 없어 오토라벨링 불가" }, { status: 400 });
      }
      if (!cols.has("thumbnail")) {
        return NextResponse.json({ error: "copy_camera_events 에 thumbnail 컬럼이 없어 오토라벨링 불가" }, { status: 400 });
      }
      const HAS_RESULT = cols.has("result"); // 판정(TP/FP) 저장 컬럼(구 스키마만)
      const TIME_COL = cols.has("event_time") ? "event_time" : cols.has("start_time") ? "start_time" : null;

      // 미분류(label_name 없음) + 썸네일 있는 이벤트만 대상
      const conds = ["label_name IS NULL", "thumbnail IS NOT NULL", "thumbnail <> ''"];
      const vals: (string | number)[] = [];
      if (cols.has("is_deleted")) conds.push("(is_deleted = 0 OR is_deleted IS NULL)");
      if (eventName) { conds.push("event_name = ?"); vals.push(eventName); }
      if (cameraId)  { conds.push("camera_id = ?");  vals.push(cameraId); }
      if (TIME_COL && startDate) { conds.push(`${TIME_COL} >= ?`); vals.push(startDate); }
      if (TIME_COL && endDate)   { conds.push(`${TIME_COL} <= ?`); vals.push(endDate + " 23:59:59"); }

      const [rows] = await db.query<RowDataPacket[]>(
        `SELECT _id, event_name, thumbnail FROM copy_camera_events
         WHERE ${conds.join(" AND ")}
         ORDER BY ${TIME_COL ? `${TIME_COL} DESC` : "_id DESC"}
         LIMIT ?`,
        [...vals, limit],
      );

      const summary = { ok: true, total: rows.length, processed: 0, tp: 0, fp: 0, tn: 0, fn: 0, errors: 0 };
      if (rows.length === 0) return NextResponse.json({ ...summary, message: "미라벨 이벤트가 없습니다." });

      // MinIO = 고객 서버(conn.host)
      let minio;
      try {
        minio = await resolveMinioClient(conn.host, minioKey, minioSecret);
      } catch (e) {
        return NextResponse.json({ error: `MinIO 연결 실패 (${conn.host}): ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
      }

      const hasAuto    = cols.has("auto_labeling");
      const hasReason  = cols.has("auto_label_reason");
      const hasUpdated = cols.has("updated_at");

      for (const ev of rows as RowDataPacket[]) {
        try {
          const imgBuf = await readMinioObject(minio, "thumbnail", parseThumbnailKey(String(ev.thumbnail)));
          const { label, reason, labelName } = await classifyWithGemini(imgBuf, String(ev.event_name ?? "unknown"));

          // label_name = 클래스(labelName). 판정(TP/FP)은 result 컬럼 있을 때만 저장(없으면 조회 시 유도)
          const sets = ["label_name = ?"];
          const uv: (string | number | null)[] = [labelName];
          if (HAS_RESULT) { sets.push("result = ?"); uv.push(label); }
          if (hasAuto)      sets.push("auto_labeling = '1'"); // varchar(64) 스키마 대응
          if (hasReason)  { sets.push("auto_label_reason = ?"); uv.push(reason); }
          if (hasUpdated)   sets.push("updated_at = NOW()");
          await db.query(`UPDATE copy_camera_events SET ${sets.join(", ")} WHERE _id = ?`, [...uv, ev._id]);

          summary.processed++;
          if (label === "TP") summary.tp++;
          else if (label === "FP") summary.fp++;
          else if (label === "TN") summary.tn++;
          else if (label === "FN") summary.fn++;
          await new Promise((r) => setTimeout(r, 1_000)); // Gemini rate limit 완화
        } catch (e) {
          summary.errors++;
          console.error(`[vms-auto-label] _id=${ev._id} 오류:`, e instanceof Error ? e.message : e);
        }
      }

      return NextResponse.json(summary);
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
