/**
 * NAS 자동 업로드 스케줄러 공유 모듈
 *
 * - AutoUploadConfig : 고객사별 설정 (site_settings에 JSON 저장)
 * - getAutoUploadConfig / saveAutoUploadConfig : 설정 CRUD
 * - runNasAutoUploadForCustomer : 단일 고객사 업로드 실행 (route + 스케줄러 공용)
 * - runNasAutoUploadSchedule : 매분 호출 — 업로드 시점이 된 고객사 직접 실행
 */

import { getPool, initDb } from "./db";
import { getCustomers, getCustomer } from "./customers";
import { logAudit } from "./audit";
import { notifyNasSftpDown } from "./teams-notify";
import mysql from "mysql2/promise";
import { Client as SshClient, SFTPWrapper } from "ssh2";
import { Client as MinioClient } from "minio";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";

const PREFIX = "auto-upload-config-";

export interface AutoUploadConfig {
  enabled:       boolean;
  intervalHours: number;
  nasSubPath:    string;
  lastRunAt:     string | null;
  lastResult:    string | null;
  isRunning:     boolean;
}

const DEFAULT_CONFIG: AutoUploadConfig = {
  enabled:       false,
  intervalHours: 1,
  nasSubPath:    "",
  lastRunAt:     null,
  lastResult:    null,
  isRunning:     false,
};

export async function getAutoUploadConfig(customerId: string): Promise<AutoUploadConfig> {
  await initDb();
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM site_settings WHERE key = $1",
      [`${PREFIX}${customerId}`],
    );
    if (!rows.length) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...(JSON.parse(rows[0].value) as Partial<AutoUploadConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveAutoUploadConfig(
  customerId: string,
  config: AutoUploadConfig,
): Promise<void> {
  await initDb();
  await getPool().query(
    `INSERT INTO site_settings (key, value, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [`${PREFIX}${customerId}`, JSON.stringify(config), new Date().toISOString()],
  );
}

// ── 업로드 헬퍼 ───────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function parseThumbnailKey(p: string): string {
  const marker = "/thumbnail/";
  const idx = p.indexOf(marker);
  return idx !== -1 ? p.slice(idx + marker.length) : p.replace(/^\//, "");
}

function parseVideoKey(p: string): string {
  const marker = "/video/";
  const idx = p.indexOf(marker);
  return idx !== -1 ? p.slice(idx + marker.length) : p.replace(/^\//, "");
}

function toFileTs(t: string): string {
  const digits = t.replace(/\D/g, "");
  return digits.slice(0, 8) + "_" + digits.slice(8, 14);
}

async function resolveMinioClient(ip: string, accessKey: string, secretKey: string): Promise<MinioClient> {
  for (const port of [9000, 32702]) {
    const client = new MinioClient({ endPoint: ip, port, useSSL: false, accessKey, secretKey });
    try {
      await withTimeout(client.bucketExists("thumbnail"), 5_000, `MinIO 포트 ${port} 응답 없음`);
      return client;
    } catch (e: unknown) {
      const msg = String(e);
      const isConnErr = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "응답 없음"].some((s) => msg.includes(s));
      if (!isConnErr) return client;
    }
  }
  throw new Error(`MinIO 연결 실패 (${ip}:9000 / ${ip}:32702)`);
}

function streamMinioToSftp(
  minio: MinioClient, bucket: string, key: string,
  sftp: SFTPWrapper, remotePath: string,
  timeoutMs = 30_000,
): Promise<void> {
  const inner = new Promise<void>(async (resolve, reject) => {
    let readStream: NodeJS.ReadableStream;
    try { readStream = await minio.getObject(bucket, key); } catch (e) { return reject(e); }
    const writeStream = sftp.createWriteStream(remotePath);
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    readStream.on("error",  (e: Error) => done(() => reject(e)));
    writeStream.on("error", (e: Error) => done(() => reject(e)));
    writeStream.on("close", ()         => done(() => resolve()));
    readStream.pipe(writeStream);
  });
  return withTimeout(inner, timeoutMs, `MinIO→SFTP 스트리밍 시간 초과 (${timeoutMs / 1000}s)`);
}

function sftpMkdirP(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const parts = remotePath.split("/").filter(Boolean);
  let current = "";
  return parts.reduce((chain, part) => chain.then(() => {
    current += "/" + part;
    return new Promise<void>((res) => sftp.mkdir(current, () => res()));
  }), Promise.resolve());
}

/** NAS에 이미 파일이 있고 크기 > 0 이면 true (재업로드 스킵용) */
function sftpExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => resolve(!err && !!stats && stats.size > 0));
  });
}

/** NAS 파일 이름 변경. 성공 시 true */
function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<boolean> {
  return new Promise((resolve) => sftp.rename(from, to, (err) => resolve(!err)));
}

/** 신형 이름으로 있으면 skip, 구형 이름으로만 있으면 신형으로 rename(라벨 지연 반영),
 *  둘 다 없으면 false(업로드 필요). 활동로그에 실제 작업량을 남기려 skip/rename 을 구분한다. */
async function reuseOnNas(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<"skip" | "rename" | false> {
  if (await sftpExists(sftp, newPath)) return "skip";
  if (oldPath !== newPath && await sftpExists(sftp, oldPath)) {
    if (await sftpRename(sftp, oldPath, newPath)) return "rename";
  }
  return false;
}

function downloadToFile(minio: MinioClient, bucket: string, key: string, localPath: string): Promise<void> {
  const inner = new Promise<void>(async (resolve, reject) => {
    let readStream: NodeJS.ReadableStream;
    try { readStream = await minio.getObject(bucket, key); } catch (e) { return reject(e); }
    const writeStream = fs.createWriteStream(localPath);
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    readStream.on("error",  (e: Error) => done(() => reject(e)));
    writeStream.on("error", (e: Error) => done(() => reject(e)));
    writeStream.on("finish", ()        => done(() => resolve()));
    readStream.pipe(writeStream);
  });
  return withTimeout(inner, 60_000, "파일 다운로드 시간 초과 (60s)");
}

function sftpPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) =>
      sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve())),
    ),
    120_000,
    "NAS 파일 전송 시간 초과 (120s)",
  );
}

function runFfmpeg(m3u8Path: string, mp4Path: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-allowed_extensions", "ALL", "-i", m3u8Path, "-c", "copy", mp4Path, "-y"],
        { maxBuffer: 50 * 1024 * 1024, timeout: 180_000 },
        (err, _stdout, stderr) => (err ? reject(new Error(stderr?.slice(-400) || err.message)) : resolve()),
      );
    }),
    180_000,
    "ffmpeg 변환 시간 초과 (3min)",
  );
}

/** 이벤트 1건 영상을 NAS로. mp4는 MinIO→SFTP 직접, m3u8(HLS)은 세그먼트 받아 ffmpeg 변환 후 전송. */
async function uploadVideoForEvent(
  minio: MinioClient, sftp: SFTPWrapper, cameraId: number,
  videoUrl: string, videoDir: string, baseName: string, oldBaseName: string,
): Promise<{ ok: boolean; action?: "skip" | "rename" | "upload"; error?: string }> {
  const remotePath = `${videoDir}/${baseName}.mp4`;
  const oldPath    = `${videoDir}/${oldBaseName}.mp4`;
  const reuse = await reuseOnNas(sftp, oldPath, remotePath);
  if (reuse) return { ok: true, action: reuse };

  const videoKey = parseVideoKey(videoUrl);

  // MP4 직접 스트리밍 (HLS 변환 불필요, VM 디스크 미사용)
  if (/\.mp4$/i.test(videoKey)) {
    try {
      await streamMinioToSftp(minio, "video", videoKey, sftp, remotePath, 120_000);
      return { ok: true, action: "upload" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[nas-auto-upload] 영상 실패 cam=${cameraId} key=${videoKey} → ${msg}`);
      return { ok: false, error: `${msg} (key=${videoKey})` };
    }
  }

  // HLS m3u8 → 세그먼트 다운로드 → ffmpeg → mp4
  const lastSlash = videoKey.lastIndexOf("/");
  const m3u8Name  = lastSlash > 0 ? videoKey.slice(lastSlash + 1) : videoKey;
  const tmpDir    = `/tmp/hls_${cameraId}_${Date.now()}`;
  const m3u8Local = `${tmpDir}/${m3u8Name}`;
  const tmpMp4    = `${tmpDir}/output.mp4`;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    await downloadToFile(minio, "video", videoKey, m3u8Local);

    const m3u8Lines = fs.readFileSync(m3u8Local, "utf8").split("\n");
    const segEntries: { key: string; basename: string }[] = [];
    for (const line of m3u8Lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const marker = "/video/";
      const idx = trimmed.indexOf(marker);
      const key = idx !== -1
        ? trimmed.slice(idx + marker.length)
        : (lastSlash > 0 ? videoKey.slice(0, lastSlash + 1) : "") + trimmed;
      segEntries.push({ key, basename: path.basename(trimmed) });
    }
    if (segEntries.length === 0) throw new Error(`m3u8에 세그먼트 없음 (key: ${videoKey})`);
    if (segEntries.length > 500) throw new Error(`세그먼트 ${segEntries.length}개 — 이벤트 클립이 아닌 전체 스트림 m3u8로 보임 (${videoKey})`);

    let firstSegError = "";
    const segResults = await Promise.allSettled(
      segEntries.map(({ key, basename: bn }) => downloadToFile(minio, "video", key, `${tmpDir}/${bn}`)),
    );
    for (const r of segResults) {
      if (r.status === "rejected") { firstSegError = r.reason instanceof Error ? r.reason.message : String(r.reason); break; }
    }

    // m3u8 재작성 (빈 세그먼트 제거)
    let skipped = 0;
    const rewritten: string[] = [];
    let pendingExtinf = "";
    for (const line of m3u8Lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const bn = path.basename(trimmed);
        let size = 0;
        try { size = fs.statSync(`${tmpDir}/${bn}`).size; } catch { /* 없음 */ }
        if (size === 0) { skipped++; pendingExtinf = ""; }
        else { if (pendingExtinf) rewritten.push(pendingExtinf); rewritten.push(bn); pendingExtinf = ""; }
        continue;
      }
      if (trimmed.startsWith("#EXTINF")) { pendingExtinf = line; continue; }
      if (pendingExtinf) { rewritten.push(pendingExtinf); pendingExtinf = ""; }
      rewritten.push(line);
    }
    if (segEntries.length - skipped === 0) {
      throw new Error(`세그먼트 ${segEntries.length}개 중 유효 파일 없음${firstSegError ? ` / 다운로드 오류: ${firstSegError}` : ""}`);
    }
    fs.writeFileSync(m3u8Local, rewritten.join("\n"));

    await runFfmpeg(m3u8Local, tmpMp4);
    await sftpPut(sftp, tmpMp4, remotePath);
    return { ok: true, action: "upload", ...(skipped > 0 ? { error: `세그먼트 ${skipped}개 스킵됨` } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(-400) : String(e);
    console.error(`[nas-auto-upload] 영상(HLS) 실패 cam=${cameraId} key=${videoKey} → ${msg}`);
    return { ok: false, error: `${msg} (key=${videoKey})` };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function uploadEventsDirect(params: {
  events: Array<{ eventId: number; cameraId: number; eventName: string; startTime: string; endTime: string | null; thumbnail: string | null; videoUrl: string | null }>;
  nasHost: string; sshUser: string; sshPassword: string; nasPort: number;
  minioIp: string; minioKey: string; minioSecret: string;
  thumbDir: string; videoDir: string;
  labelMap: Record<string, string>;
}): Promise<{ thumbSuccess: number; thumbTotal: number; videoSuccess: number; videoTotal: number; uploaded: number; renamed: number; errors: string[] }> {
  const { events, nasHost, sshUser, sshPassword, nasPort, minioIp, minioKey, minioSecret, thumbDir, videoDir, labelMap } = params;

  const minio = await resolveMinioClient(minioIp, minioKey, minioSecret);

  const { sftp, conn } = await withTimeout(
    new Promise<{ sftp: SFTPWrapper; conn: SshClient }>((resolve, reject) => {
      const c = new SshClient();
      let settled = false;
      const fail = (e: Error) => { if (!settled) { settled = true; reject(e); try { c.end(); } catch {} } };
      c.on("error",   (err) => fail(err));
      c.on("timeout", ()    => fail(new Error("SSH 연결 시간 초과")));
      c.on("ready", () => {
        c.sftp((err, s) => { if (err) { fail(err); return; } settled = true; resolve({ sftp: s, conn: c }); });
      });
      c.connect({ host: nasHost, port: nasPort, username: sshUser, password: sshPassword, readyTimeout: 10_000, keepaliveInterval: 10_000, keepaliveCountMax: 30 });
    }),
    15_000,
    "SSH/SFTP 연결 시간 초과 (15s)",
  );

  try {
    await sftpMkdirP(sftp, thumbDir);
    await sftpMkdirP(sftp, videoDir);

    let thumbSuccess = 0, thumbTotal = 0, videoSuccess = 0, videoTotal = 0;
    let uploaded = 0, renamed = 0;   // 실제 작업량(skip 제외) — 활동로그용
    const errors: string[] = [];

    for (const ev of events) {
      const startTs     = toFileTs(ev.startTime);
      const endTs       = ev.endTime ? toFileTs(ev.endTime) : startTs;
      const oldBaseName = `${ev.cameraId}_${ev.eventName}_${startTs}`;
      // 라벨: 자동(_id) → NAS 수동({cam}_{event}_{start}) 순 조회
      const label       = labelMap[String(ev.eventId)] ?? labelMap[oldBaseName];
      const baseName    = label
        ? `${ev.cameraId}_${ev.eventName}_${label}_${startTs}_${endTs}`
        : oldBaseName;

      // 썸네일
      if (ev.thumbnail) {
        thumbTotal++;
        const remotePath = `${thumbDir}/${baseName}.jpg`;
        const oldPath    = `${thumbDir}/${oldBaseName}.jpg`;
        const reuse = await reuseOnNas(sftp, oldPath, remotePath);
        if (reuse === "skip") { thumbSuccess++; }
        else if (reuse === "rename") { thumbSuccess++; renamed++; }
        else {
          try {
            await streamMinioToSftp(minio, "thumbnail", parseThumbnailKey(ev.thumbnail), sftp, remotePath);
            thumbSuccess++; uploaded++;
          } catch (e) {
            errors.push(`${baseName}(썸네일): ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      // 영상
      if (ev.videoUrl) {
        videoTotal++;
        const r = await uploadVideoForEvent(minio, sftp, ev.cameraId, ev.videoUrl, videoDir, baseName, oldBaseName);
        if (r.ok) {
          videoSuccess++;
          if (r.action === "upload") uploaded++;
          else if (r.action === "rename") renamed++;
        } else errors.push(`${baseName}(영상): ${r.error ?? "실패"}`);
      }
    }

    return { thumbSuccess, thumbTotal, videoSuccess, videoTotal, uploaded, renamed, errors };
  } finally {
    try { conn.end(); } catch {}
  }
}

// ── 핵심 실행 함수 (route + 스케줄러 공용) ────────────────────────────────────

export interface UploadRunResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  count?: number;
  result?: string;
  error?: string;
}

/**
 * 단일 고객사 NAS 자동 업로드 실행.
 * HTTP self-call 없이 직접 호출 — route.ts POST 핸들러와 스케줄러 양쪽에서 사용.
 */
export async function runNasAutoUploadForCustomer(customerId: string): Promise<UploadRunResult> {
  const customer = await getCustomer(customerId);
  if (!customer) return { ok: false, error: "고객사 없음" };

  const config = await getAutoUploadConfig(customerId);
  if (!config.nasSubPath) config.nasSubPath = customer.name;

  // isRunning stuck 자가치유: 배포/프로세스 재시작으로 이전 런이 finish() 를 못 돌면
  // isRunning=true 가 DB 에 남아 이후 "지금 실행"·스케줄이 계속 "이미 실행 중"으로 스킵된다
  // (결과가 옛 실패에서 안 바뀜). 마지막 실행이 30분 넘었으면 stuck 으로 보고 진행한다.
  if (config.isRunning) {
    const lastRun = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
    if (Date.now() - lastRun < 30 * 60_000) {
      return { ok: true, skipped: true, reason: "이미 실행 중" };
    }
    console.warn(`[nas-auto-upload] ${customer.name} isRunning stuck → 강제 진행`);
  }

  await saveAutoUploadConfig(customerId, { ...config, isRunning: true });

  const finish = async (lastResult: string) => {
    const latest = await getAutoUploadConfig(customerId);
    await saveAutoUploadConfig(customerId, { ...latest, isRunning: false, lastRunAt: new Date().toISOString(), lastResult });
  };

  try {
    if (!customer.dbPassword || !customer.dbName) {
      await finish("DB 설정 누락");
      return { ok: false, error: "DB 설정 누락" };
    }

    const ip       = customer.vip || customer.ip || (() => { try { return new URL(customer.apiUrl).hostname; } catch { return ""; } })();
    const now      = new Date();
    // 라벨(TP/FP)은 자동 라벨링이 별도 스케줄로 돌아 업로드보다 늦게 붙는 일이 많다.
    // 그래서 커서(lastRunAt)만 쓰면 이미 올린 파일이 미라벨로 남는다. 최근
    // RELABEL_LOOKBACK 안의 이벤트는 매 런 다시 훑어, 라벨이 새로 생겼으면
    // uploadEventsDirect 의 reuseOnNas 가 파일명을 rename 으로 갱신한다(재다운로드 없음,
    // 이미 라벨명으로 있으면 stat 한 번으로 skip). 다운타임이 더 길었으면 lastRunAt
    // 까지 거슬러 올라가 놓친 업로드도 따라잡는다.
    // ponytail: LIMIT 100 이라 24시간에 이벤트가 100건을 넘는 초대형 고객사는 가장
    //           최근 100건만 relabel 대상. 그런 규모가 생기면 LIMIT/윈도우를 키운다.
    const RELABEL_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
    const cursor   = config.lastRunAt ? new Date(config.lastRunAt).getTime() : now.getTime() - 24 * 60 * 60 * 1_000;
    const since    = new Date(Math.min(cursor, now.getTime() - RELABEL_LOOKBACK_MS));
    const sinceStr = since.toISOString().replace("T", " ").slice(0, 19);
    const untilStr = now.toISOString().replace("T", " ").slice(0, 19);

    let conn: mysql.Connection | null = null;
    let events: Array<{ eventId: number; cameraId: number; eventName: string; startTime: string; endTime: string | null; thumbnail: string | null; videoUrl: string | null }> = [];

    try {
      conn = await mysql.createConnection({
        host: ip, port: customer.dbPort ?? 3306,
        user: customer.dbUser ?? "ops", password: customer.dbPassword,
        database: customer.dbName, connectTimeout: 8_000,
      });

      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT _id, camera_id, event_name, start_time, end_time, thumbnail, video_url
         FROM camera_events
         WHERE start_time > ?
           AND start_time <= ?
           AND (thumbnail IS NOT NULL OR video_url IS NOT NULL)
         ORDER BY start_time DESC
         LIMIT 100`,
        [sinceStr, untilStr],
      );

      const toStr = (v: unknown) => v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : v != null ? String(v) : null;
      events = rows.map((r) => ({
        eventId:   r._id        as number,
        cameraId:  r.camera_id  as number,
        eventName: r.event_name as string,
        startTime: toStr(r.start_time) ?? "",
        endTime:   toStr(r.end_time),
        thumbnail: r.thumbnail  as string | null,
        videoUrl:  r.video_url  as string | null,
      }));
    } finally {
      await conn?.end();
    }

    console.log(`[nas-auto-upload] ${customer.name}: ${events.length}건 조회 | ${sinceStr} ~ ${untilStr}`);

    if (events.length === 0) {
      await finish("신규 이벤트 없음");
      return { ok: true, count: 0 };
    }

    // NAS 접속은 env(NAS_SSH_*)만 사용. customer.sshUser/sshPassword는 고객사 자체
    // 서버(VMS) SSH 계정이라 NAS(nas01/watch)와 무관 — 이걸 쓰면 auth 실패한다.
    const nasHost     = process.env.NAS_SSH_HOST      ?? "192.0.2.20"; // example
    const sshUser     = process.env.NAS_SSH_USER      ?? "ops";
    const sshPassword = process.env.NAS_SSH_PASSWORD  ?? "";
    const nasPort     = Number(process.env.NAS_SSH_PORT ?? 22);
    const minioIp     = ip;
    const minioKey    = process.env.MINIO_ACCESS_KEY ?? "";
    const minioSecret = process.env.MINIO_SECRET_KEY ?? "";

    if (!sshPassword) {
      await finish("SSH 비밀번호 미설정");
      return { ok: false, error: "SSH 비밀번호 미설정" };
    }
    if (!minioKey || !minioSecret) {
      await finish("MinIO 인증 정보 미설정");
      return { ok: false, error: "MINIO_ACCESS_KEY / MINIO_SECRET_KEY 환경변수 미설정" };
    }

    const nasBase   = (customer.nasPath ?? "/rtpulse").replace(/\/$/, "");
    const subPath   = (config.nasSubPath ?? "").replace(/^\//, "").replace(/\/$/, "");
    const targetDir = subPath ? `${nasBase}/${subPath}` : nasBase;
    const thumbDir  = `${targetDir}/thumbnail`;
    const videoDir  = `${targetDir}/video`;

    // 라벨(TP/FP 등) 조회 — file_name 은 자동(_id)·NAS수동({cam}_{event}_{start}) 형식 공존
    const labelMap: Record<string, string> = {};
    try {
      const { rows } = await getPool().query<{ file_name: string; result: string }>(
        "SELECT file_name, result FROM detection_results WHERE customer_id = $1 AND result IS NOT NULL",
        [customerId],
      );
      for (const r of rows) labelMap[r.file_name] = r.result;
    } catch { /* 라벨 조회 실패해도 업로드 진행 */ }

    const { thumbSuccess, thumbTotal, videoSuccess, videoTotal, uploaded, renamed, errors } = await uploadEventsDirect({
      events, nasHost, sshUser, sshPassword, nasPort,
      minioIp, minioKey, minioSecret, thumbDir, videoDir, labelMap,
    });

    if (errors.length > 0) {
      console.warn(`[nas-auto-upload] ${customer.name} 업로드 오류 ${errors.length}건:`, errors.slice(0, 3));
    }

    const msg = `썸네일 ${thumbSuccess}/${thumbTotal} · 영상 ${videoSuccess}/${videoTotal}건 완료`;
    await finish(msg);

    // 활동로그: 실제 작업(업로드/라벨반영) 또는 오류가 있을 때만 남긴다(무변화 런은 스킵).
    // 파일이 하나라도 실패하면 '실패'로 표시한다(부분 실패도 실패 — 안 올라간 파일을
    // 놓치지 않게). 원인 파악용으로 첫 오류 메시지도 detail 에 남긴다.
    if (uploaded > 0 || renamed > 0 || errors.length > 0) {
      await logAudit({
        actor: "system", action: "nas-auto-upload",
        target_type: "customer", target_id: customerId, target_label: customer.name,
        status: errors.length > 0 ? "failure" : "success",
        detail: `업로드 ${uploaded} · 라벨반영(rename) ${renamed}`
          + (errors.length > 0 ? ` · 오류 ${errors.length}` : "")
          + ` (썸네일 ${thumbSuccess}/${thumbTotal}, 영상 ${videoSuccess}/${videoTotal})`
          + (errors.length > 0 ? ` — ${errors[0].slice(0, 200)}` : ""),
      });
    }
    return { ok: true, count: events.length, result: msg };

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[nas-auto-upload] ${customer.name} 오류:`, msg);
    await finish(`오류: ${msg}`);
    await logAudit({
      actor: "system", action: "nas-auto-upload",
      target_type: "customer", target_id: customerId, target_label: customer.name,
      status: "failure", detail: `오류: ${msg}`,
    });
    maybeAlertSftpDown(msg);
    return { ok: false, error: msg };
  }
}

// SFTP 연결/세션 단계 실패(전 고객사 동시 영향)만 골라 Teams 알림.
// 파일별 오류는 여기 오지 않음(catch 는 연결 실패 경로) → 오탐 없음.
// 도배 방지: 프로세스 메모리 쿨다운(재배포 시 리셋되지만 재알림 1회는 허용).
const SFTP_DOWN_RE = /establishing SFTP session|SFTP 연결|Connection closed|exit code 2|ECONNREFUSED|Connection reset/i;
const SFTP_ALERT_COOLDOWN_MS = 30 * 60_000;
let lastSftpAlertAt = 0;
function maybeAlertSftpDown(msg: string): void {
  if (!SFTP_DOWN_RE.test(msg)) return;
  const now = Date.now();
  if (now - lastSftpAlertAt < SFTP_ALERT_COOLDOWN_MS) return;
  lastSftpAlertAt = now;
  void notifyNasSftpDown(msg); // notifyNasSftpDown 내부에서 예외 처리
}

/**
 * instrumentation.ts에서 1분마다 호출.
 * 업로드 시점이 된 고객사를 HTTP self-call 없이 직접 실행.
 */
export async function runNasAutoUploadSchedule(): Promise<void> {
  try {
    await initDb();
    const customers = await getCustomers();
    const now = Date.now();

    for (const customer of customers) {
      // VMS DB 접속 정보가 없으면 스킵 (SSH 인증은 runNasAutoUploadForCustomer에서 환경변수 폴백 처리)
      if (!customer.dbPassword) continue;

      let config = await getAutoUploadConfig(customer.id);
      if (!config.enabled) continue;

      // isRunning stuck 감지: 30분 이상 running 상태면 강제 해제
      if (config.isRunning) {
        const lastRun = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
        if (Date.now() - lastRun < 30 * 60_000) continue; // 30분 미만 → 정상 실행 중
        console.warn(`[nas-auto-upload] ${customer.name} isRunning stuck 감지 → 강제 해제`);
        config = { ...config, isRunning: false };
        await saveAutoUploadConfig(customer.id, config);
      }

      const lastRun    = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
      const intervalMs = config.intervalHours * 60 * 60 * 1_000;
      if (now - lastRun < intervalMs) continue; // 아직 시간 안 됨

      console.log(`[nas-auto-upload] ${customer.name} 자동 업로드 트리거`);

      // fire-and-forget — HTTP self-call 없이 직접 함수 호출
      runNasAutoUploadForCustomer(customer.id)
        .then((result) => {
          console.log(`[nas-auto-upload] ${customer.name} 완료:`, result.result ?? result.error ?? result);
        })
        .catch((e: Error) => {
          console.error(`[nas-auto-upload] ${customer.name} 오류:`, e.message);
        });
    }
  } catch (e: unknown) {
    console.error("[nas-auto-upload] schedule 오류:", e instanceof Error ? e.message : String(e));
  }
}
