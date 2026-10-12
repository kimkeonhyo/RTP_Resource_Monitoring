/**
 * Gemini Auto-Labeling
 *
 * 고객사 유형별로 다른 썸네일 소스를 사용합니다:
 *   - 원격(remote, VMS DB 있음): MySQL camera_events → MinIO 썸네일
 *   - 온프레미스(onprem) / NAS 업로드: event_registrations → NAS SFTP 썸네일
 *
 * 환경변수:
 *   GOOGLE_AI_STUDIO_API_KEY  — Google AI Studio API 키 (필수)
 *   GEMINI_MODEL              — 사용할 모델 (기본: gemini-2.0-flash)
 *   AUTO_LABEL_BATCH          — 고객사당 1회 최대 처리 건수 (기본: 50)
 */

import { Client as SshClient } from "ssh2";
import { Client as MinioClient } from "minio";
import mysql from "mysql2/promise";
import { getPool, initDb } from "./db";
import { getCustomers } from "./customers";
import { logAudit } from "./audit";
import type { Customer } from "./types";

/* ── 환경변수 ──────────────────────────────────────────────────────────────── */

const GEMINI_API_KEY  = () => process.env.GOOGLE_AI_STUDIO_API_KEY ?? "";
const GEMINI_MODEL    = () => process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const BATCH_LIMIT     = () => Number(process.env.AUTO_LABEL_BATCH ?? "50");

/* ── NAS SFTP 유틸 (온프레미스/NAS 업로드용) ──────────────────────────────── */

function readNasThumbnail(
  thumbPath: string,
  host: string,
  port: number,
  user: string,
  password: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const conn  = new SshClient();
    let settled = false;
    const done  = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const timer = setTimeout(() => {
      done(() => { try { conn.destroy(); } catch { /**/ } reject(new Error("SSH 연결 시간 초과")); });
    }, 12_000);

    conn.on("error", (e) => done(() => { clearTimeout(timer); reject(e); }));
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { done(() => { clearTimeout(timer); conn.end(); reject(err); }); return; }
        const chunks: Buffer[] = [];
        const rs = sftp.createReadStream(thumbPath);
        rs.on("data",  (c: Buffer) => chunks.push(c));
        rs.on("end",   () => done(() => { clearTimeout(timer); conn.end(); resolve(Buffer.concat(chunks)); }));
        rs.on("error", (e: Error) => done(() => { clearTimeout(timer); conn.end(); reject(e); }));
      });
    });
    conn.connect({ host, port, username: user, password, readyTimeout: 8_000, keepaliveInterval: 10_000 });
  });
}

/* ── NAS 파일명 파싱 유틸 ─────────────────────────────────────────────────── */

/**
 * NAS baseName에서 cameraId / eventName / eventTime 추출
 * 형식: {cameraId}_{eventName}_{YYYYMMDD}_{HHMMSS}
 * 예)   5_smoke_20260418_000103
 */
function parseBaseName(baseName: string): { cameraId?: string; eventName?: string; eventTime?: string } {
  const m = baseName.match(/^(.+?)_(.+)_(\d{8})_(\d{6})$/);
  if (!m) return {};
  const [, cameraId, eventName, date, time] = m;
  const eventTime = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  return { cameraId, eventName, eventTime };
}

/* ── MinIO 유틸 (원격 고객사용) ──────────────────────────────────────────── */

/** "/thumbnail/path/to/file.jpg" → "path/to/file.jpg" */
export function parseThumbnailKey(p: string): string {
  const marker = "/thumbnail/";
  const idx = p.indexOf(marker);
  return idx !== -1 ? p.slice(idx + marker.length) : p.replace(/^\//, "");
}

/** MinIO 클라이언트 생성 (9000 → 32702 순서로 시도) */
export async function resolveMinioClient(
  ip: string,
  accessKey: string,
  secretKey: string,
): Promise<MinioClient> {
  for (const port of [9000, 32702]) {
    const client = new MinioClient({ endPoint: ip, port, useSSL: false, accessKey, secretKey });
    try {
      await Promise.race([
        client.bucketExists("thumbnail"),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5_000)),
      ]);
      return client;
    } catch { /**/ }
  }
  throw new Error(`MinIO 연결 실패 (${ip}:9000 / ${ip}:32702)`);
}

/** MinIO 객체를 Buffer로 읽기 */
export async function readMinioObject(
  minio: MinioClient,
  bucket: string,
  key: string,
): Promise<Buffer> {
  const stream = await minio.getObject(bucket, key);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data",  (c: Buffer) => chunks.push(c));
    stream.on("end",   () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/* ── Gemini API ────────────────────────────────────────────────────────────── */

const GEMINI_ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

/** label_name 상세 분류가 필요한 이벤트 목록 */
const LABEL_NAME_EVENTS = new Set(["falldown", "smoke", "fire", "esfalldown"]);

/** FP일 때 Gemini가 선택할 수 있는 실제 상황 레이블 */
const VALID_FP_LABELS   = ["falldown", "smoke", "fire", "esfalldown", "normal"] as const;

export async function classifyWithGemini(
  imageBuffer: Buffer,
  eventName: string,
): Promise<{ label: "TP" | "FP" | "TN" | "FN"; reason: string; labelName: string | null }> {
  const apiKey = GEMINI_API_KEY();
  if (!apiKey) throw new Error("GOOGLE_AI_STUDIO_API_KEY 환경변수가 설정되지 않았습니다.");

  const model  = GEMINI_MODEL();
  const base64 = imageBuffer.toString("base64");

  // ── "normal" 이벤트: TN/FN 분류 ──────────────────────────────────────────
  if (eventName.toLowerCase() === "normal") {
    const normalPrompt = `당신은 보안 카메라 영상 분석 AI입니다.
아래 이미지는 "normal(정상)" 이벤트로 분류된 보안 카메라 썸네일입니다.
(이 영상은 이상 상황이 탐지되지 않았거나 정상으로 분류된 장면입니다.)

이미지에 실제로 이상 상황이 존재하는지 판단하세요.

[판단 기준]
- TN (True Negative): 이미지가 실제로 정상적인 상황 — 이상 없음
- FN (False Negative): 이미지에서 이상 상황이 실제로 발생했으나 탐지되지 않음 (미탐지)

[FN 이상 상황 유형 — FN일 경우 반드시 아래 중 하나를 셋째 줄에 출력]
- falldown   : 사람이 쓰러지거나 낙상
- smoke      : 연기 발생
- fire       : 화재·불꽃 발생
- esfalldown : 에스컬레이터 위에서 낙상

[출력 형식 — 반드시 준수]
첫 줄: TN 또는 FN (단독으로)
둘째 줄: 판단 근거 (한 문장, 한국어)
셋째 줄: TN이면 "normal", FN이면 위 이상 상황 유형 중 하나`;

    const normalBody = {
      contents: [{ parts: [
        { text: normalPrompt },
        { inline_data: { mime_type: "image/jpeg", data: base64 } },
      ]}],
      generationConfig: { temperature: 0.05, maxOutputTokens: 128 },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
    };

    const normalRes = await fetch(GEMINI_ENDPOINT(model, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalBody),
      signal: AbortSignal.timeout(30_000),
    });

    if (!normalRes.ok) {
      const txt = await normalRes.text().catch(() => "");
      throw new Error(`Gemini API ${normalRes.status}: ${txt.slice(0, 200)}`);
    }

    const normalJson = await normalRes.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message: string };
    };

    if (normalJson.error) throw new Error(`Gemini 오류: ${normalJson.error.message}`);

    const normalRawText = (normalJson.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
    const normalLines   = normalRawText.split("\n").map((s) => s.trim()).filter(Boolean);
    const normalFirst   = (normalLines[0] ?? "").toUpperCase();
    const normalReason  = normalLines[1] ?? "";

    if (!normalFirst.startsWith("TN") && !normalFirst.startsWith("FN")) {
      throw new Error(`Gemini 응답 파싱 실패 (normal): "${normalRawText.slice(0, 80)}"`);
    }

    const normalLabel: "TN" | "FN" = normalFirst.startsWith("TN") ? "TN" : "FN";
    let normalLabelName: string | null = null;
    if (normalLabel === "TN") {
      normalLabelName = "normal";
    } else {
      const thirdLine = (normalLines[2] ?? "").toLowerCase();
      normalLabelName = VALID_FP_LABELS.find((l) => l !== "normal" && thirdLine.includes(l)) ?? null;
    }

    return { label: normalLabel, reason: normalReason, labelName: normalLabelName };
  }

  // ── 일반 이벤트: TP/FP 분류 ───────────────────────────────────────────────
  const needsLabelName = LABEL_NAME_EVENTS.has(eventName.toLowerCase());

  const prompt = needsLabelName
    ? `당신은 보안 카메라 이벤트 분석 AI입니다.
아래 이미지는 "${eventName}" 이벤트가 감지된 순간의 보안 카메라 썸네일입니다.

[판단 기준]
- TP (True Positive): 이미지에서 이벤트명에 해당하는 실제 상황이 명확히 확인됨
- FP (False Positive): 이미지가 정상이거나 이벤트명과 관계없는 상황

[FP 실제 상황 레이블 — FP일 경우 반드시 아래 중 하나를 셋째 줄에 출력]
- normal     : 특별한 상황 없음 (일상적인 장면)
- falldown   : 사람이 쓰러지거나 낙상하는 상황
- smoke      : 연기 발생
- fire       : 화재·불꽃 발생
- esfalldown : 에스컬레이터 위에서 낙상하는 상황

[출력 형식 — 반드시 준수]
첫 줄: TP 또는 FP (단독으로)
둘째 줄: 판단 근거 (한 문장, 한국어)
셋째 줄: TP이면 "${eventName}", FP이면 실제 상황 레이블(위 목록 중 하나)`
    : `당신은 보안 카메라 이벤트 분석 AI입니다.
아래 이미지는 "${eventName}" 이벤트가 감지된 순간의 보안 카메라 썸네일입니다.

[판단 기준]
- TP (True Positive): 이미지에서 이벤트명에 해당하는 실제 상황이 명확히 확인됨
  예) 사람 침입(intrusion) → 사람이 보임 / 차량(vehicle) → 차량이 보임 / 화재(fire) → 연기·불꽃이 보임
- FP (False Positive): 이미지가 정상이거나 이벤트명과 관계없는 상황
  예) 빈 공간, 조명 변화, 그림자, 동물, 나뭇잎 흔들림 등

[출력 형식 — 반드시 준수]
첫 줄: TP 또는 FP (단독으로)
둘째 줄: 판단 근거 (한 문장, 한국어)`;

  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: "image/jpeg", data: base64 } },
    ]}],
    generationConfig: { temperature: 0.05, maxOutputTokens: 128 },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };

  const res = await fetch(GEMINI_ENDPOINT(model, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gemini API ${res.status}: ${txt.slice(0, 200)}`);
  }

  const json = await res.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message: string };
  };

  if (json.error) throw new Error(`Gemini 오류: ${json.error.message}`);

  const rawText  = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
  const lines    = rawText.split("\n").map((s) => s.trim()).filter(Boolean);
  const firstLine = (lines[0] ?? "").toUpperCase();
  const reason    = lines[1] ?? "";

  if (!firstLine.startsWith("TP") && !firstLine.startsWith("FP")) {
    throw new Error(`Gemini 응답 파싱 실패: "${rawText.slice(0, 80)}"`);
  }

  const label: "TP" | "FP" = firstLine.startsWith("TP") ? "TP" : "FP";

  // label_name 결정
  let labelName: string | null = null;
  if (needsLabelName) {
    if (label === "TP") {
      labelName = eventName.toLowerCase();
    } else {
      // 셋째 줄에서 FP 실제 상황 레이블 추출
      const thirdLine = (lines[2] ?? "").toLowerCase();
      labelName = VALID_FP_LABELS.find((l) => thirdLine.includes(l)) ?? "normal";
    }
  }

  return { label, reason, labelName };
}

/* ── DB upsert 헬퍼 ────────────────────────────────────────────────────────── */

async function saveLabel(
  customerId: string,
  customerName: string,
  fileName: string,
  label: "TP" | "FP" | "TN" | "FN",
  reason: string,
  meta?: { eventName?: string; cameraId?: string; eventTime?: string; labelName?: string | null; thumbnail?: string | null },
): Promise<void> {
  const pool = getPool();
  const now = new Date().toISOString();

  // 기존 detection_results upsert (NAS 라벨링 워크플로우 유지)
  await pool.query(
    `INSERT INTO detection_results
       (customer_id, customer_name, file_name, result, auto_labeled, auto_label_reason, updated_at,
        event_name, camera_id, event_time, label_name)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (customer_id, file_name)
     DO UPDATE SET
       result            = EXCLUDED.result,
       auto_labeled      = TRUE,
       auto_label_reason = EXCLUDED.auto_label_reason,
       updated_at        = EXCLUDED.updated_at,
       event_name        = COALESCE(EXCLUDED.event_name, detection_results.event_name),
       camera_id         = COALESCE(EXCLUDED.camera_id,  detection_results.camera_id),
       event_time        = COALESCE(EXCLUDED.event_time, detection_results.event_time),
       label_name        = EXCLUDED.label_name
     WHERE detection_results.result IS NULL OR detection_results.auto_labeled = TRUE`,
    [
      customerId, customerName, fileName, label, reason, now,
      meta?.eventName ?? null, meta?.cameraId ?? null, meta?.eventTime ?? null,
      meta?.labelName ?? null,
    ],
  );

  // copy_camera_events upsert (APO 전용 — Excel 명세서 컬럼명 기준)
  await pool.query(
    `INSERT INTO copy_camera_events
       (_id, customer_id, customer_name, updated_at, event_time,
        camera_id, event_name, thumbnail, label_name, result,
        auto_labeling, auto_label_reason, is_media_exist)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11, $12)
     ON CONFLICT (customer_id, _id)
     DO UPDATE SET
       result            = EXCLUDED.result,
       auto_labeling     = TRUE,
       auto_label_reason = EXCLUDED.auto_label_reason,
       updated_at        = EXCLUDED.updated_at,
       event_time        = COALESCE(EXCLUDED.event_time,  copy_camera_events.event_time),
       camera_id         = COALESCE(EXCLUDED.camera_id,   copy_camera_events.camera_id),
       event_name        = COALESCE(EXCLUDED.event_name,  copy_camera_events.event_name),
       thumbnail         = COALESCE(EXCLUDED.thumbnail,   copy_camera_events.thumbnail),
       label_name        = EXCLUDED.label_name,
       is_media_exist    = CASE WHEN EXCLUDED.thumbnail IS NOT NULL THEN TRUE
                                ELSE copy_camera_events.is_media_exist END
     WHERE copy_camera_events.result IS NULL OR copy_camera_events.auto_labeling = TRUE`,
    [
      fileName, customerId, customerName, now,
      meta?.eventTime ?? null, meta?.cameraId ?? null, meta?.eventName ?? null,
      meta?.thumbnail ?? null, meta?.labelName ?? null, label,
      reason, meta?.thumbnail != null,
    ],
  );
}

/* ── 공개 인터페이스 ────────────────────────────────────────────────────────── */

export interface CustomerLabelSummary {
  customerId:   string;
  customerName: string;
  total:        number;
  processed:    number;
  tp:           number;
  fp:           number;
  tn:           number;
  fn:           number;
  errors:       number;
}

/* ── 원격 고객사: MySQL camera_events + MinIO ──────────────────────────────── */

async function runAutoLabelRemote(
  customer: Customer,
  batchLimit: number,
  fileNames?: string[],
): Promise<CustomerLabelSummary> {
  const summary: CustomerLabelSummary = {
    customerId: customer.id, customerName: customer.name,
    total: 0, processed: 0, tp: 0, fp: 0, tn: 0, fn: 0, errors: 0,
  };

  const pool = getPool();

  // MySQL 접속 정보
  const ip         = customer.vip ?? customer.ip ?? new URL(customer.apiUrl).hostname;
  const dbPort     = customer.dbPort ?? 3306;
  const dbUser     = customer.dbUser ?? "ops";
  const dbPassword = customer.dbPassword ?? "";
  const dbName     = customer.dbName ?? "";

  if (!dbPassword || !dbName) return summary;

  // MySQL에서 이벤트 조회
  let conn: mysql.Connection | null = null;
  let events: { _id: number; event_name: string; thumbnail: string; camera_id: number; start_time: Date | string | null }[] = [];
  try {
    conn = await mysql.createConnection({
      host: ip, port: dbPort, user: dbUser, password: dbPassword,
      database: dbName, connectTimeout: 8_000,
    });

    if (fileNames && fileNames.length > 0) {
      // 선택된 이벤트만 처리 (_id IN (...))
      const placeholders = fileNames.map(() => "?").join(", ");
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT _id, event_name, thumbnail, camera_id, start_time
         FROM camera_events
         WHERE _id IN (${placeholders})
           AND thumbnail IS NOT NULL AND thumbnail != ''`,
        fileNames.map(Number),
      );
      events = rows as typeof events;
    } else {
      // result가 확정된(TP/FP) file_name만 제외 — NULL(미선택)은 라벨링 대상
      const { rows: labeled } = await pool.query<{ file_name: string }>(
        `SELECT file_name FROM detection_results WHERE customer_id = $1 AND result IS NOT NULL`,
        [customer.id],
      );
      const labeledSet = new Set(labeled.map((r) => r.file_name));

      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT _id, event_name, thumbnail, camera_id, start_time
         FROM camera_events
         WHERE thumbnail IS NOT NULL AND thumbnail != ''
         ORDER BY start_time DESC
         LIMIT ?`,
        [batchLimit * 3],  // 여유분 포함 — labeled 제외 후 batchLimit 개 확보
      );
      events = (rows as typeof events)
        .filter((r) => r.thumbnail && !labeledSet.has(String(r._id)))
        .slice(0, batchLimit);
    }
  } catch (e) {
    console.error(`[auto-label] ${customer.name} MySQL 오류:`, e instanceof Error ? e.message : e);
    return summary;
  } finally {
    await conn?.end();
  }

  summary.total = events.length;
  if (events.length === 0) return summary;

  console.log(`[auto-label] ${customer.name} (원격): ${events.length}건 처리 시작`);

  // MinIO 클라이언트 초기화
  const minioKey    = process.env.MINIO_ACCESS_KEY ?? "";
  const minioSecret = process.env.MINIO_SECRET_KEY ?? "";
  let minio: MinioClient;
  try {
    minio = await resolveMinioClient(ip, minioKey, minioSecret);
  } catch (e) {
    console.error(`[auto-label] ${customer.name} MinIO 연결 실패:`, e instanceof Error ? e.message : e);
    return summary;
  }

  for (const ev of events) {
    try {
      const key    = parseThumbnailKey(ev.thumbnail);
      const imgBuf = await readMinioObject(minio, "thumbnail", key);
      const { label, reason, labelName } = await classifyWithGemini(imgBuf, ev.event_name ?? "unknown");

      // start_time from MySQL is UTC (stored as DATETIME)
      const eventTimeUtc = ev.start_time instanceof Date
        ? ev.start_time.toISOString().replace("T", " ").slice(0, 19)
        : ev.start_time ? String(ev.start_time).slice(0, 19) : undefined;

      await saveLabel(customer.id, customer.name, String(ev._id), label, reason, {
        eventName: ev.event_name || undefined,                           // null·"" → undefined
        cameraId:  ev.camera_id != null ? String(ev.camera_id) : undefined, // null 안전
        eventTime: eventTimeUtc || undefined,
        labelName,
        thumbnail: ev.thumbnail || null,
      });

      summary.processed++;
      if (label === "TP")      summary.tp++;
      else if (label === "FP") summary.fp++;
      else if (label === "TN") summary.tn++;
      else if (label === "FN") summary.fn++;
      console.log(`[auto-label] ${customer.name} / _id=${ev._id} → ${label}${labelName ? ` [${labelName}]` : ""}  (${reason})`);

      await new Promise((r) => setTimeout(r, 1_000));
    } catch (e) {
      summary.errors++;
      console.error(
        `[auto-label] ${customer.name} / _id=${ev._id} 오류:`,
        e instanceof Error ? e.message : String(e),
      );
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  return summary;
}

/* ── 온프레미스 / NAS 업로드: event_registrations + NAS SFTP ─────────────── */

async function runAutoLabelNas(
  customer: Customer,
  batchLimit: number,
  nasHost: string,
  nasPort: number,
  nasUser: string,
  nasPass: string,
  fileNames?: string[],
  thumbPaths?: Record<string, string>,
): Promise<CustomerLabelSummary> {
  const summary: CustomerLabelSummary = {
    customerId: customer.id, customerName: customer.name,
    total: 0, processed: 0, tp: 0, fp: 0, tn: 0, fn: 0, errors: 0,
  };

  const pool = getPool();

  let rows: { base_name: string; event_name: string | null; thumb_path: string | null; camera_id: string | null; start_time: string | null }[];

  if (fileNames && fileNames.length > 0 && thumbPaths && Object.keys(thumbPaths).length > 0) {
    // ── thumbPaths 직접 전달된 경우 — event_registrations DB 조회 없이 NAS 파일 직접 처리
    //    (NasList: 아직 등록되지 않은 파일도 라벨링 가능)
    rows = fileNames
      .filter((bn) => thumbPaths[bn])
      .map((bn) => ({
        base_name:  bn,
        event_name: null,
        thumb_path: thumbPaths[bn],
        camera_id:  null,
        start_time: null,
      }));
  } else if (fileNames && fileNames.length > 0) {
    // ── 선택된 base_name만 event_registrations에서 조회
    const { rows: r } = await pool.query<{
      base_name:  string;
      event_name: string | null;
      thumb_path: string | null;
      camera_id:  string | null;
      start_time: string | null;
    }>(
      `SELECT er.base_name, er.event_name, er.thumb_path, er.camera_id, er.start_time
       FROM event_registrations er
       WHERE er.customer_id = $1
         AND er.base_name   = ANY($2)
         AND er.thumb_path  IS NOT NULL
         AND er.thumb_path  != ''`,
      [customer.id, fileNames],
    );
    rows = r;
  } else {
    // 미라벨 이벤트 전체 처리
    const { rows: r } = await pool.query<{
      base_name:  string;
      event_name: string | null;
      thumb_path: string | null;
      camera_id:  string | null;
      start_time: string | null;
    }>(
      `SELECT er.base_name, er.event_name, er.thumb_path, er.camera_id, er.start_time
       FROM event_registrations er
       LEFT JOIN detection_results dr
         ON dr.customer_id = er.customer_id
        AND dr.file_name   = er.base_name
       WHERE er.customer_id = $1
         AND er.thumb_path  IS NOT NULL
         AND er.thumb_path  != ''
         AND (dr.id IS NULL OR dr.result IS NULL)
       ORDER BY er.registered_at DESC
       LIMIT $2`,
      [customer.id, batchLimit],
    );
    rows = r;
  }

  summary.total = rows.length;
  if (rows.length === 0) return summary;

  console.log(`[auto-label] ${customer.name} (NAS): ${rows.length}건 처리 시작`);

  for (const row of rows) {
    const { base_name, event_name, thumb_path, camera_id, start_time } = row;
    if (!thumb_path) continue;
    try {
      // DB에 값이 없으면 baseName에서 파싱 (예: 5_smoke_20260418_000103)
      const parsed = parseBaseName(base_name);
      const finalEventName = event_name || parsed.eventName || undefined;
      const finalCameraId  = camera_id  || parsed.cameraId  || undefined;
      const finalEventTime = start_time || parsed.eventTime || undefined;

      const imgBuf = await readNasThumbnail(thumb_path, nasHost, nasPort, nasUser, nasPass);
      const { label, reason, labelName } = await classifyWithGemini(imgBuf, finalEventName ?? base_name);

      await saveLabel(customer.id, customer.name, base_name, label, reason, {
        eventName: finalEventName,
        cameraId:  finalCameraId,
        eventTime: finalEventTime,
        labelName,
        thumbnail: thumb_path || null,
      });

      summary.processed++;
      if (label === "TP")      summary.tp++;
      else if (label === "FP") summary.fp++;
      else if (label === "TN") summary.tn++;
      else if (label === "FN") summary.fn++;
      console.log(`[auto-label] ${customer.name} / ${base_name} → ${label}${labelName ? ` [${labelName}]` : ""}  (${reason})`);

      await new Promise((r) => setTimeout(r, 1_000));
    } catch (e) {
      summary.errors++;
      console.error(
        `[auto-label] ${customer.name} / ${base_name} 오류:`,
        e instanceof Error ? e.message : String(e),
      );
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  return summary;
}

/* ── 메인 진입점 ───────────────────────────────────────────────────────────── */

/**
 * @param targetCustomerId  지정 시 해당 고객사만 (수동 트리거)
 *                          미지정 시 site_settings에서 활성화된 고객사만 (4시간 스케줄러)
 * @param fileNames         지정 시 해당 file_name(또는 _id)만 처리 (수동 선택 실행)
 * @param thumbPaths        baseName → NAS 절대 경로 맵.
 *                          제공 시 event_registrations 조회 없이 SFTP 직접 읽기
 *                          (NasList의 미등록 파일 라벨링에 사용)
 */
export async function runAutoLabel(targetCustomerId?: string, fileNames?: string[], thumbPaths?: Record<string, string>): Promise<CustomerLabelSummary[]> {
  const apiKey = GEMINI_API_KEY();
  if (!apiKey) {
    console.warn("[auto-label] GOOGLE_AI_STUDIO_API_KEY 미설정 — 건너뜀");
    return [];
  }

  await initDb();
  const pool         = getPool();
  const allCustomers = await getCustomers();

  // 대상 고객사 결정
  let customers: Customer[];
  if (targetCustomerId) {
    customers = allCustomers.filter((c) => c.id === targetCustomerId);
  } else {
    // site_settings에서 활성화된 고객사만 (키: auto_label__{id})
    const enabledIds = new Set<string>();
    await Promise.all(
      allCustomers.map(async (c) => {
        try {
          const { rows } = await pool.query(
            `SELECT value FROM site_settings WHERE key = $1`,
            [`auto_label__${c.id}`],
          );
          if (rows[0]?.value === "true") enabledIds.add(c.id);
        } catch { /**/ }
      }),
    );
    customers = allCustomers.filter((c) => enabledIds.has(c.id));
    if (customers.length === 0) {
      console.log("[auto-label] 활성화된 고객사 없음 — 건너뜀");
      return [];
    }
  }

  // NAS 공통 접속 정보
  const nasHost = process.env.NAS_SSH_HOST ?? "192.0.2.20"; // example
  const nasPort = Number(process.env.NAS_SSH_PORT ?? "22");
  const nasUser = process.env.NAS_SSH_USER ?? "ops";
  const nasPass = process.env.NAS_SSH_PASSWORD ?? "";

  const batchLimit  = BATCH_LIMIT();
  const summaries: CustomerLabelSummary[] = [];

  for (const customer of customers) {
    try {
      let summary: CustomerLabelSummary;

      if (thumbPaths && Object.keys(thumbPaths).length > 0 && nasPass) {
        // thumbPaths 직접 제공 → NAS SFTP 직접 읽기 (MySQL 여부 무관)
        // NasList 업로드 완료 탭에서 미등록 파일 라벨링 시 사용
        summary = await runAutoLabelNas(customer, batchLimit, nasHost, nasPort, nasUser, nasPass, fileNames, thumbPaths);
      } else if (customer.dbPassword && customer.dbName) {
        // 원격 고객사: VMS MySQL DB + MinIO 썸네일
        summary = await runAutoLabelRemote(customer, batchLimit, fileNames);
      } else if (nasPass) {
        // 온프레미스 또는 NAS 업로드된 원격: event_registrations + NAS SFTP
        summary = await runAutoLabelNas(customer, batchLimit, nasHost, nasPort, nasUser, nasPass, fileNames, thumbPaths);
      } else {
        console.warn(`[auto-label] ${customer.name}: DB·NAS 접속정보 없음 — 건너뜀`);
        continue;
      }

      console.log(
        `[auto-label] ${customer.name} 완료: TP=${summary.tp} FP=${summary.fp} TN=${summary.tn} FN=${summary.fn} 오류=${summary.errors}`,
      );
      // 활동로그: 실제 라벨링했거나 오류가 있을 때만 남긴다(무변화 런 스킵).
      if (summary.processed > 0 || summary.errors > 0) {
        await logAudit({
          actor: "system", action: "auto-label",
          target_type: "customer", target_id: customer.id, target_label: customer.name,
          status: summary.errors > 0 ? "failure" : "success",
          detail: `라벨링 ${summary.processed}건 (TP ${summary.tp} · FP ${summary.fp} · TN ${summary.tn} · FN ${summary.fn})`
            + (summary.errors > 0 ? ` · 오류 ${summary.errors}` : ""),
        });
      }
      summaries.push(summary);
    } catch (e) {
      const emsg = e instanceof Error ? e.message : String(e);
      console.error(`[auto-label] ${customer.name} 전체 오류:`, emsg);
      await logAudit({
        actor: "system", action: "auto-label",
        target_type: "customer", target_id: customer.id, target_label: customer.name,
        status: "failure", detail: `오류: ${emsg}`,
      });
    }
  }

  const total = summaries.reduce((s, r) => s + r.processed, 0);
  console.log(`[auto-label] 전체 완료: ${total}건 라벨링`);
  return summaries;
}
