import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/apo/events
 * copy_camera_events 기반 APO 이벤트 목록 + 통계
 *
 * Query params:
 *   customerId, eventName, cameraId, result (TP|FP|TN|FN|null=미선택),
 *   autoLabeling (true|false), isWatched (true|false),
 *   startDate (YYYY-MM-DD), endDate (YYYY-MM-DD),
 *   page (1-based), pageSize (10~100, default 50)
 */
export async function GET(req: NextRequest) {
  await initDb();
  const pool = getPool();

  const sp            = req.nextUrl.searchParams;
  const customerId    = sp.get("customerId")   || null;
  const eventName     = sp.get("eventName")    || null;
  const cameraId      = sp.get("cameraId")     || null;
  const resultFilter  = sp.get("result")       || null; // "TP"|"FP"|"TN"|"FN"|"null"
  const autoLabeling  = sp.get("autoLabeling") || null; // "true"|"false"
  const isWatched     = sp.get("isWatched")    || null; // "true"|"false"
  const startDate     = sp.get("startDate")    || null;
  const endDate       = sp.get("endDate")      || null;
  const page     = Math.max(1, parseInt(sp.get("page") ?? "1", 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(sp.get("pageSize") ?? "50", 10)));

  const conditions: string[] = ["(cce.is_deleted = FALSE OR cce.is_deleted IS NULL)"];
  const values: (string | boolean)[] = [];
  let idx = 1;

  if (customerId) { conditions.push(`cce.customer_id = $${idx++}`); values.push(customerId); }
  if (eventName)  { conditions.push(`cce.event_name  = $${idx++}`); values.push(eventName);  }
  if (cameraId)   { conditions.push(`cce.camera_id   = $${idx++}`); values.push(cameraId);   }

  if (resultFilter === "null") {
    conditions.push("cce.result IS NULL");
  } else if (resultFilter) {
    conditions.push(`cce.result = $${idx++}`); values.push(resultFilter);
  }

  if (autoLabeling === "true")  conditions.push("cce.auto_labeling = TRUE");
  if (autoLabeling === "false") conditions.push("(cce.auto_labeling = FALSE OR cce.auto_labeling IS NULL)");
  if (isWatched   === "true")   conditions.push("cce.is_watched = TRUE");
  if (isWatched   === "false")  conditions.push("(cce.is_watched = FALSE OR cce.is_watched IS NULL)");

  if (startDate) { conditions.push(`cce.event_time >= $${idx++}`); values.push(startDate); }
  if (endDate)   { conditions.push(`cce.event_time <= $${idx++}`); values.push(endDate + "T23:59:59"); }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // 통계
  const statsRes = await pool.query(
    `SELECT
       COUNT(*)                                           AS total,
       COUNT(*) FILTER (WHERE cce.result = 'TP')         AS tp,
       COUNT(*) FILTER (WHERE cce.result = 'FP')         AS fp,
       COUNT(*) FILTER (WHERE cce.result = 'TN')         AS tn,
       COUNT(*) FILTER (WHERE cce.result = 'FN')         AS fn,
       COUNT(*) FILTER (WHERE cce.result IS NULL)         AS unlabeled,
       COUNT(*) FILTER (WHERE cce.auto_labeling = TRUE)   AS auto_labeled_count,
       COUNT(*) FILTER (WHERE cce.is_watched    = TRUE)   AS watched_count
     FROM copy_camera_events cce
     ${where}`,
    values
  );
  const s = statsRes.rows[0];
  const total = parseInt(s.total, 10);

  // 이벤트 목록
  const offset = (page - 1) * pageSize;
  const eventsRes = await pool.query(
    `SELECT
       cce._id, cce.customer_id, cce.customer_name,
       cce.camera_id, cce.event_name, cce.event_time, cce.updated_at,
       cce.result, cce.label_name, cce.new_event_name,
       cce.auto_labeling, cce.auto_label_reason,
       cce.thumbnail, cce.video_url,
       cce.is_media_exist, cce.roi_coordinates, cce.type,
       COALESCE(cce.is_watched, FALSE) AS is_watched,
       COALESCE(cce.is_deleted, FALSE) AS is_deleted
     FROM copy_camera_events cce
     ${where}
     ORDER BY cce.event_time DESC NULLS LAST, cce.updated_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, pageSize, offset]
  );

  // 필터용 distinct 값
  const distinctEventNames = await pool.query(
    `SELECT DISTINCT event_name FROM copy_camera_events WHERE event_name IS NOT NULL ORDER BY event_name`
  );
  const distinctCameraIds = await pool.query(
    customerId
      ? `SELECT DISTINCT camera_id FROM copy_camera_events WHERE customer_id = $1 AND camera_id IS NOT NULL ORDER BY camera_id`
      : `SELECT DISTINCT camera_id FROM copy_camera_events WHERE camera_id IS NOT NULL ORDER BY camera_id`,
    customerId ? [customerId] : []
  );

  return NextResponse.json({
    events:     eventsRes.rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    stats: {
      tp:               parseInt(s.tp, 10),
      fp:               parseInt(s.fp, 10),
      tn:               parseInt(s.tn, 10),
      fn:               parseInt(s.fn, 10),
      unlabeled:        parseInt(s.unlabeled, 10),
      autoLabeledCount: parseInt(s.auto_labeled_count, 10),
      watchedCount:     parseInt(s.watched_count, 10),
    },
    meta: {
      eventNames: distinctEventNames.rows.map((r) => r.event_name as string),
      cameraIds:  distinctCameraIds.rows.map((r)  => r.camera_id  as string),
    },
  });
}

/**
 * PATCH /api/apo/events
 * Body: { customerId, id, result?, labelName?, newEventName?, isWatched?, isDeleted? }
 * copy_camera_events의 _id 기준으로 업데이트
 */
export async function PATCH(req: NextRequest) {
  await initDb();
  const pool = getPool();

  const body = await req.json() as {
    customerId:    string;
    id:            string;       // copy_camera_events._id
    result?:       "TP" | "FP" | "TN" | "FN" | null;
    labelName?:    string | null;
    newEventName?: string | null;
    isWatched?:    boolean;
    isDeleted?:    boolean;
  };

  const { customerId, id } = body;
  if (!customerId || !id) {
    return NextResponse.json({ error: "customerId and id required" }, { status: 400 });
  }

  const updates: string[] = [];
  const vals: (string | boolean | null)[] = [];
  let i = 1;

  if ("result"       in body) { updates.push(`result         = $${i++}`); vals.push(body.result       ?? null); }
  if ("labelName"    in body) { updates.push(`label_name     = $${i++}`); vals.push(body.labelName    ?? null); }
  if ("newEventName" in body) { updates.push(`new_event_name = $${i++}`); vals.push(body.newEventName ?? null); }
  if ("isWatched"    in body) { updates.push(`is_watched     = $${i++}`); vals.push(body.isWatched    ?? false); }
  if ("isDeleted"    in body) { updates.push(`is_deleted     = $${i++}`); vals.push(body.isDeleted    ?? false); }

  // 수동으로 결과/라벨을 설정하면 auto_labeling = FALSE 로 표시
  // → 이후 오토라벨링 스케줄이 이 이벤트를 덮어쓰지 못하게 막음
  if ("result" in body || "labelName" in body) {
    updates.push(`auto_labeling = $${i++}`);
    vals.push(false);
  }

  if (updates.length === 0) return NextResponse.json({ ok: true });

  updates.push(`updated_at = $${i++}`);
  vals.push(new Date().toISOString());

  await pool.query(
    `UPDATE copy_camera_events SET ${updates.join(", ")}
     WHERE customer_id = $${i++} AND _id = $${i++}`,
    [...vals, customerId, id]
  );

  // detection_results도 동기화 (file_name = _id)
  const drUpdates: string[] = [];
  const drVals: (string | boolean | null)[] = [];
  let j = 1;
  if ("result"    in body) { drUpdates.push(`result     = $${j++}`); drVals.push(body.result    ?? null); }
  if ("labelName" in body) { drUpdates.push(`label_name = $${j++}`); drVals.push(body.labelName ?? null); }
  if ("isWatched" in body) { drUpdates.push(`is_watched = $${j++}`); drVals.push(body.isWatched ?? false); }
  if ("isDeleted" in body) { drUpdates.push(`is_deleted = $${j++}`); drVals.push(body.isDeleted ?? false); }

  if (drUpdates.length > 0) {
    drUpdates.push(`updated_at = $${j++}`);
    drVals.push(new Date().toISOString());
    await pool.query(
      `UPDATE detection_results SET ${drUpdates.join(", ")}
       WHERE customer_id = $${j++} AND file_name = $${j++}`,
      [...drVals, customerId, id]
    ).catch(() => { /* detection_results에 없는 경우 무시 */ });
  }

  return NextResponse.json({ ok: true });
}
