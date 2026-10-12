import { NextRequest, NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { withVmsDb, type VmsDbConn } from "@/lib/vms-db";

export const runtime = "nodejs";

/**
 * POST /api/apo/vms/events/query
 * VMS MySQL DB의 copy_camera_events 조회
 *
 * Body: { conn, eventName?, cameraId?, result?, autoLabeling?, startDate?, endDate?, page?, pageSize? }
 * Response: { events, total, page, pageSize, totalPages, stats, meta }
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    conn:          VmsDbConn;
    eventName?:    string;
    cameraId?:     string;
    result?:       string;
    autoLabeling?: string;
    startDate?:    string;
    endDate?:      string;
    page?:         number;
    pageSize?:     number;
  };

  const { conn, eventName, cameraId, result, autoLabeling, startDate, endDate } = body;
  const page     = Math.max(1, body.page     ?? 1);
  const pageSize = Math.min(100, Math.max(10, body.pageSize ?? 50));

  if (!conn?.host || !conn?.user || !conn?.dbName) {
    return NextResponse.json({ error: "conn (host, user, dbName) required" }, { status: 400 });
  }

  try {
    return await withVmsDb(conn, async (db) => {
      // 실제 컬럼 목록 먼저 확인
      const [colRows] = await db.query<RowDataPacket[]>(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'copy_camera_events'",
        [conn.dbName]
      );
      const cols = new Set((colRows as RowDataPacket[]).map((r) => r.COLUMN_NAME as string));

      // 테이블 부재 → 조용히 빈 목록으로 오인되지 않도록 명확히 알림
      if (cols.size === 0) {
        return NextResponse.json(
          { error: `'${conn.dbName}' DB에 copy_camera_events 테이블이 없습니다. 해당 고객사 DB에 copy_camera_events 준비가 선행되어야 합니다 (현재 site_d_stage2만 확인됨).` },
          { status: 404 },
        );
      }

      const HAS_RESULT       = cols.has("result");
      const HAS_LABEL        = cols.has("label_name");
      const HAS_AUTO         = cols.has("auto_labeling");
      const HAS_IS_DELETED   = cols.has("is_deleted");
      const HAS_IS_WATCHED   = cols.has("is_watched");
      const HAS_HAS_WATCHED  = cols.has("has_watched");   // VMS DB 대체 컬럼
      const HAS_THUMBNAIL    = cols.has("thumbnail");
      const HAS_VIDEO        = cols.has("video_url");
      const HAS_MEDIA_EXIST  = cols.has("is_media_exist");
      const HAS_ROI          = cols.has("roi_coordinates");
      const HAS_UPDATED_AT   = cols.has("updated_at");
      const HAS_AUTO_REASON  = cols.has("auto_label_reason");
      // event_time vs start_time (VMS DB)
      const TIME_COL         = cols.has("event_time") ? "event_time" : cols.has("start_time") ? "start_time" : null;
      // label_name = 클래스(falldown/fire/smoke/normal). 라벨링결과로 표시.
      // 판정(TP/FP/TN/FN)은 result 컬럼(구 스키마) 또는 event_name↔label_name 비교로 유도(현 스키마).
      const RESULT_EXPR = HAS_RESULT
        ? "result"
        : HAS_LABEL
          ? "CASE WHEN label_name IS NULL THEN NULL WHEN event_name='normal' THEN (CASE WHEN label_name='normal' THEN 'TN' ELSE 'FN' END) WHEN label_name=event_name THEN 'TP' ELSE 'FP' END"
          : "NULL";

      const conditions: string[] = [
        HAS_IS_DELETED ? "(is_deleted = 0 OR is_deleted IS NULL)" : "1=1",
      ];
      const values: (string | number)[] = [];

      if (eventName) { conditions.push("event_name = ?"); values.push(eventName); }
      if (cameraId)  { conditions.push("camera_id = ?");  values.push(cameraId); }

      if (RESULT_EXPR !== "NULL") {
        if (result === "null") conditions.push(`(${RESULT_EXPR}) IS NULL`);
        else if (result) { conditions.push(`(${RESULT_EXPR}) = ?`); values.push(result); }
      }
      if (HAS_AUTO) {
        if (autoLabeling === "true")  conditions.push("auto_labeling = 1");
        if (autoLabeling === "false") conditions.push("(auto_labeling = 0 OR auto_labeling IS NULL)");
      }
      if (TIME_COL) {
        if (startDate) { conditions.push(`${TIME_COL} >= ?`); values.push(startDate); }
        if (endDate)   { conditions.push(`${TIME_COL} <= ?`); values.push(endDate + " 23:59:59"); }
      }

      const where = `WHERE ${conditions.join(" AND ")}`;

      // 통계
      const statsSql = `
        SELECT
          COUNT(*) AS total
          ${RESULT_EXPR !== "NULL" ? `, SUM((${RESULT_EXPR})='TP') AS tp, SUM((${RESULT_EXPR})='FP') AS fp, SUM((${RESULT_EXPR})='TN') AS tn, SUM((${RESULT_EXPR})='FN') AS fn, SUM((${RESULT_EXPR}) IS NULL) AS unlabeled` : ", 0 AS tp, 0 AS fp, 0 AS tn, 0 AS fn, 0 AS unlabeled"}
          ${HAS_AUTO   ? ", SUM(auto_labeling=1) AS auto_labeled_count" : ", 0 AS auto_labeled_count"}
        FROM copy_camera_events ${where}`;
      const [statsRows] = await db.query<RowDataPacket[]>(statsSql, values);
      const s     = statsRows[0];
      const total = Number(s.total);

      // 이벤트 목록 — 존재하는 컬럼만 SELECT
      const watchedExpr = HAS_IS_WATCHED
        ? "COALESCE(is_watched,0) AS is_watched"
        : HAS_HAS_WATCHED
          ? "COALESCE(has_watched,0) AS is_watched"
          : "0 AS is_watched";

      const selectCols = [
        "_id", "camera_id",
        ...(cols.has("event_name") ? ["event_name"] : []),
        ...(TIME_COL ? [`${TIME_COL} AS event_time`] : []),
        ...(HAS_UPDATED_AT   ? ["updated_at"]        : []),
        // 탐지결과(판정) → result(유도 가능), 라벨링결과(클래스) → label_name
        ...(RESULT_EXPR !== "NULL" ? [`${RESULT_EXPR} AS result`] : []),
        ...(HAS_LABEL              ? ["label_name"]              : []),
        ...(HAS_AUTO         ? ["auto_labeling"]     : []),
        ...(HAS_AUTO_REASON  ? ["auto_label_reason"] : []),
        ...(HAS_THUMBNAIL    ? ["thumbnail"]         : []),
        ...(HAS_VIDEO        ? ["video_url"]         : []),
        ...(HAS_MEDIA_EXIST  ? ["is_media_exist"]    : []),
        ...(HAS_ROI          ? ["roi_coordinates"]   : []),
        watchedExpr,
        ...(HAS_IS_DELETED   ? ["COALESCE(is_deleted,0) AS is_deleted"] : ["0 AS is_deleted"]),
      ].join(", ");

      const orderBy = TIME_COL
        ? `${TIME_COL} DESC${HAS_UPDATED_AT ? ", updated_at DESC" : ""}`
        : "_id DESC";

      const offset = (page - 1) * pageSize;
      const [rows] = await db.query<RowDataPacket[]>(
        `SELECT ${selectCols} FROM copy_camera_events ${where}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
        [...values, pageSize, offset]
      );

      // distinct 값
      const [nameRows] = await db.query<RowDataPacket[]>(
        "SELECT DISTINCT event_name FROM copy_camera_events WHERE event_name IS NOT NULL ORDER BY event_name"
      );
      const [camRows] = await db.query<RowDataPacket[]>(
        "SELECT DISTINCT camera_id FROM copy_camera_events WHERE camera_id IS NOT NULL ORDER BY camera_id"
      );

      // MySQL은 boolean 컬럼을 0/1로 반환 → JS boolean으로 변환
      const events = (rows as RowDataPacket[]).map((r) => ({
        ...r,
        customer_id:   conn.dbName,
        customer_name: conn.dbName,
        auto_labeling: !!r.auto_labeling,
        is_watched:    !!r.is_watched,
        is_deleted:    !!r.is_deleted,
      }));

      return NextResponse.json({
        events,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        stats: {
          tp:               Number(s.tp   ?? 0),
          fp:               Number(s.fp   ?? 0),
          tn:               Number(s.tn   ?? 0),
          fn:               Number(s.fn   ?? 0),
          unlabeled:        Number(s.unlabeled ?? 0),
          autoLabeledCount: Number(s.auto_labeled_count ?? 0),
          watchedCount:     0,
        },
        meta: {
          eventNames: (nameRows as RowDataPacket[]).map((r) => r.event_name as string),
          cameraIds:  (camRows  as RowDataPacket[]).map((r) => r.camera_id  as string),
        },
      });
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
