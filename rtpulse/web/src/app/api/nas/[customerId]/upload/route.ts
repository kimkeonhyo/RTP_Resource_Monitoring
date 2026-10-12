import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getPool, initDb } from "@/lib/db";
import { Client as SshClient, SFTPWrapper } from "ssh2";
import { Client as MinioClient } from "minio";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";

type Params = { params: Promise<{ customerId: string }> };

interface UploadEvent {
  eventId: number;
  cameraId: number;
  eventName: string;
  startTime: string;
  endTime: string | null;
  thumbnail: string | null;
  videoUrl: string | null;
}

interface EventResult {
  cameraId:  number;
  startTime: string;
  thumbnail: { ok: boolean; error?: string; skipped?: boolean } | null;
  video:     { ok: boolean; error?: string; skipped?: boolean } | null;
}

interface JobResult {
  thumbnail: { success: number; total: number };
  video:     { success: number; total: number };
  targetDir: string;
  results:   EventResult[];
}

// ── Background job store ──────────────────────────────────────────────────────
// Node.js 단일 프로세스 내 Map으로 충분 (Docker standalone 환경)

type JobStatus = "processing" | "done" | "error";

interface UploadJob {
  status:    JobStatus;
  progress:  string;
  result?:   JobResult;
  error?:    string;
  createdAt: number;
}

const jobStore = new Map<string, UploadJob>();

function createJob(): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  jobStore.set(id, { status: "processing", progress: "시작 중...", createdAt: Date.now() });
  // 1시간 후 자동 정리
  setTimeout(() => jobStore.delete(id), 3_600_000);
  return id;
}

function setProgress(id: string, progress: string) {
  const j = jobStore.get(id);
  if (j) jobStore.set(id, { ...j, progress });
}

function finishJob(id: string, result: JobResult) {
  const j = jobStore.get(id);
  if (j) jobStore.set(id, { ...j, status: "done", progress: "완료", result });
}

function failJob(id: string, error: string) {
  const j = jobStore.get(id);
  if (j) jobStore.set(id, { ...j, status: "error", progress: "실패", error });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function toFileTs(t: string): string {
  const digits = t.replace(/\D/g, "");
  return digits.slice(0, 8) + "_" + digits.slice(8, 14);
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

async function resolveMinioClient(ip: string, accessKey: string, secretKey: string): Promise<MinioClient> {
  for (const port of [9000, 32702]) {
    const client = new MinioClient({ endPoint: ip, port, useSSL: false, accessKey, secretKey });
    try {
      await withTimeout(
        client.bucketExists("thumbnail"),
        5_000,
        `MinIO 포트 ${port} 응답 없음 (5s 초과)`,
      );
      return client;
    } catch (e: unknown) {
      const msg = String(e);
      const isConnErr = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "응답 없음"].some(
        (s) => msg.includes(s),
      );
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
    try {
      readStream = await minio.getObject(bucket, key);
    } catch (e) { return reject(e); }
    const writeStream = sftp.createWriteStream(remotePath);
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    readStream.on("error",   (e: Error) => done(() => reject(e)));
    writeStream.on("error",  (e: Error) => done(() => reject(e)));
    writeStream.on("timeout", ()        => done(() => reject(new Error("stream timeout"))));
    writeStream.on("close",   ()        => done(() => resolve()));
    readStream.pipe(writeStream);
  });
  return withTimeout(inner, timeoutMs, `MinIO→SFTP 스트리밍 시간 초과 (${timeoutMs / 1000}s)`);
}

function downloadToFile(
  minio: MinioClient, bucket: string, key: string, localPath: string,
): Promise<void> {
  const inner = new Promise<void>(async (resolve, reject) => {
    let readStream: NodeJS.ReadableStream;
    try {
      readStream = await minio.getObject(bucket, key);
    } catch (e) { return reject(e); }
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

/**
 * 이미 NAS에 있으면 재업로드를 피한다.
 *  - 신형 이름(newPath)으로 있으면 → 그대로 스킵
 *  - 구형 이름(oldPath)으로만 있으면 → 신형 이름으로 rename (재다운로드 없이 라벨 적용)
 * 처리했으면 true, 없으면(=업로드 필요) false.
 */
async function reuseOnNas(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<boolean> {
  if (await sftpExists(sftp, newPath)) return true;
  if (oldPath !== newPath && await sftpExists(sftp, oldPath)) {
    if (await sftpRename(sftp, oldPath, newPath)) return true;
  }
  return false;
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
        (err, _stdout, stderr) => {
          if (err) reject(new Error(stderr?.slice(-400) || err.message));
          else resolve();
        },
      );
    }),
    180_000,
    "ffmpeg 변환 시간 초과 (3min)",
  );
}

// ── Background upload task ────────────────────────────────────────────────────

async function runUploadJob(
  jobId: string,
  minio: MinioClient,
  nasHost: string, sshUser: string, sshPassword: string, nasPort: number,
  events: UploadEvent[],
  thumbDir: string, videoDir: string, targetDir: string,
  labelMap: Record<string, string> = {},
): Promise<void> {
  // SSH 연결
  const { sftp, conn } = await withTimeout(
    new Promise<{ sftp: SFTPWrapper; conn: SshClient }>((resolve, reject) => {
      const c = new SshClient();
      let settled = false;
      const fail = (e: Error) => { if (!settled) { settled = true; reject(e); try { c.end(); } catch {} } };
      c.on("error",   (err) => fail(err));
      c.on("timeout", ()    => fail(new Error("SSH 연결 시간 초과")));
      c.on("ready", () => {
        c.sftp((err, sftp) => {
          if (err) { fail(err); return; }
          settled = true;
          resolve({ sftp, conn: c });
        });
      });
      c.connect({
        host: nasHost, port: nasPort,
        username: sshUser, password: sshPassword,
        readyTimeout:      10_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 30,
      });
    }),
    15_000,
    "SSH/SFTP 연결 시간 초과 (15s)",
  );

  try {
    await sftpMkdirP(sftp, thumbDir);
    await sftpMkdirP(sftp, videoDir);

    const results: EventResult[] = [];

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const startTs  = toFileTs(ev.startTime);
      const endTs    = ev.endTime ? toFileTs(ev.endTime) : startTs;
      // 라벨(TP/FP 등) 조회 — detection_results.file_name 은 두 형식이 공존:
      //   · 자동 라벨링(DB): _id       · NAS 수동 라벨링: {cam}_{event}_{startTs}
      const label    = labelMap[String(ev.eventId)] ?? labelMap[`${ev.cameraId}_${ev.eventName}_${startTs}`];
      // 구형 이름(라벨/종료시각 없음) — 중복검사·rename 용
      const oldBaseName = `${ev.cameraId}_${ev.eventName}_${startTs}`;
      // 라벨 있으면: {cam}_{event}_{TP|FP}_{start}_{end}, 없으면 구형 형식 유지
      const baseName = label
        ? `${ev.cameraId}_${ev.eventName}_${label}_${startTs}_${endTs}`
        : oldBaseName;
      const result: EventResult = { cameraId: ev.cameraId, startTime: ev.startTime, thumbnail: null, video: null };

      setProgress(jobId, `처리 중 ${i + 1}/${events.length}: ${baseName}`);

      // 썸네일
      if (ev.thumbnail) {
        const remotePath = `${thumbDir}/${baseName}.jpg`;
        const oldPath    = `${thumbDir}/${oldBaseName}.jpg`;
        if (await reuseOnNas(sftp, oldPath, remotePath)) {
          result.thumbnail = { ok: true, skipped: true }; // 이미 있음(신형) 또는 구형→신형 rename
        } else {
          const objectKey = parseThumbnailKey(ev.thumbnail);
          try {
            await streamMinioToSftp(minio, "thumbnail", objectKey, sftp, remotePath);
            result.thumbnail = { ok: true };
          } catch (e) {
            result.thumbnail = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
      }

      // 영상
      if (ev.videoUrl) {
        const remotePath = `${videoDir}/${baseName}.mp4`;
        const oldPath    = `${videoDir}/${oldBaseName}.mp4`;

        if (await reuseOnNas(sftp, oldPath, remotePath)) {
          result.video = { ok: true, skipped: true }; // 이미 있음(신형) 또는 구형→신형 rename
        } else {
        const videoKey = parseVideoKey(ev.videoUrl);

        // ── MP4 직접 스트리밍 (HLS 변환 불필요) ──────────────────────────────
        if (/\.mp4$/i.test(videoKey)) {
          try {
            setProgress(jobId, `[${i+1}/${events.length}] MP4 스트리밍 → NAS: ${baseName}`);
            // MinIO video bucket → SFTP NAS (VM 디스크 사용 없음, 120초 타임아웃)
            await streamMinioToSftp(minio, "video", videoKey, sftp, remotePath, 120_000);
            result.video = { ok: true };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[nas-upload] 영상 실패 cam=${ev.cameraId} ${ev.startTime} key=${videoKey} url=${ev.videoUrl} → ${msg}`);
            result.video = { ok: false, error: `${msg} (key=${videoKey})` };
          }
        } else {
        // ── HLS m3u8 → ffmpeg → mp4 변환 ────────────────────────────────────
        const lastSlash  = videoKey.lastIndexOf("/");
        const m3u8Name   = lastSlash > 0 ? videoKey.slice(lastSlash + 1) : videoKey;
        const tmpDir     = `/tmp/hls_${ev.cameraId}_${Date.now()}`;
        const m3u8Local  = `${tmpDir}/${m3u8Name}`;
        const tmpMp4     = `${tmpDir}/output.mp4`;

        try {
          fs.mkdirSync(tmpDir, { recursive: true });

          setProgress(jobId, `[${i+1}/${events.length}] m3u8 다운로드: ${baseName}`);
          await downloadToFile(minio, "video", videoKey, m3u8Local);

          const m3u8Raw   = fs.readFileSync(m3u8Local, "utf8");
          const m3u8Lines = m3u8Raw.split("\n");
          const segEntries: { key: string; basename: string }[] = [];
          for (const line of m3u8Lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const videoMarker = "/video/";
            const idx = trimmed.indexOf(videoMarker);
            const key = idx !== -1
              ? trimmed.slice(idx + videoMarker.length)
              : (lastSlash > 0 ? videoKey.slice(0, lastSlash + 1) : "") + trimmed;
            segEntries.push({ key, basename: path.basename(trimmed) });
          }
          if (segEntries.length === 0) throw new Error(`m3u8에 세그먼트 없음 (key: ${videoKey})`);

          // 세그먼트 수가 비정상적으로 많으면 일반 이벤트 클립이 아님 (전체 스트림 등)
          if (segEntries.length > 500) {
            throw new Error(
              `세그먼트 수 ${segEntries.length}개 — 이벤트 클립이 아닌 전체 스트림 m3u8로 보입니다. ` +
              `m3u8 경로: ${videoKey} / 첫 세그먼트 키: ${segEntries[0]?.key}`,
            );
          }

          setProgress(jobId, `[${i+1}/${events.length}] 세그먼트 ${segEntries.length}개 다운로드: ${baseName}`);

          // 세그먼트 다운로드 — 첫 번째 실패 이유도 기록
          let firstSegError = "";
          const segResults = await Promise.allSettled(
            segEntries.map(({ key, basename: bn }) =>
              downloadToFile(minio, "video", key, `${tmpDir}/${bn}`),
            ),
          );
          if (!firstSegError) {
            for (const r of segResults) {
              if (r.status === "rejected") {
                firstSegError = r.reason instanceof Error ? r.reason.message : String(r.reason);
                break;
              }
            }
          }

          // m3u8 재작성 (빈 파일 제거)
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
            const hint = firstSegError ? ` / 다운로드 오류: ${firstSegError}` : "";
            const keyHint = ` / 첫 세그먼트 키: ${segEntries[0]?.key}`;
            throw new Error(`세그먼트 ${segEntries.length}개 중 유효한 파일 없음${hint}${keyHint}`);
          }
          fs.writeFileSync(m3u8Local, rewritten.join("\n"));

          setProgress(jobId, `[${i+1}/${events.length}] ffmpeg 변환: ${baseName}`);
          await runFfmpeg(m3u8Local, tmpMp4);

          setProgress(jobId, `[${i+1}/${events.length}] NAS 업로드: ${baseName}.mp4`);
          await sftpPut(sftp, tmpMp4, remotePath);

          result.video = {
            ok: true,
            ...(skipped > 0 ? { error: `세그먼트 ${skipped}개 스킵됨` } : {}),
          } as EventResult["video"];
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(-400) : String(e);
          console.error(`[nas-upload] 영상(HLS) 실패 cam=${ev.cameraId} ${ev.startTime} key=${videoKey} url=${ev.videoUrl} → ${msg}`);
          result.video = { ok: false, error: `${msg} (key=${videoKey})` };
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        } // end HLS else block
        } // end NAS-exists else block

      }

      results.push(result);
    }

    conn.end();

    const thumbOk    = results.filter((r) => r.thumbnail?.ok).length;
    const videoOk    = results.filter((r) => r.video?.ok).length;
    const thumbTotal = results.filter((r) => r.thumbnail !== null).length;
    const videoTotal = results.filter((r) => r.video !== null).length;

    finishJob(jobId, {
      thumbnail: { success: thumbOk, total: thumbTotal },
      video:     { success: videoOk, total: videoTotal },
      targetDir,
      results,
    });
  } catch (e) {
    try { conn.end(); } catch {}
    failJob(jobId, e instanceof Error ? e.message : String(e));
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

/**
 * GET /api/nas/{customerId}/upload?jobId=xxx
 * 업로드 잡 상태 조회 (클라이언트 폴링용)
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId 필요" }, { status: 400 });
  const job = jobStore.get(jobId);
  if (!job) return NextResponse.json({ error: "Job을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json(job);
}

/**
 * POST /api/nas/{customerId}/upload
 * 업로드 잡 시작 → 즉시 { jobId } 반환, 백그라운드에서 처리
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const nasHost     = process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
  const sshUser     = process.env.NAS_SSH_USER     ?? "ops";
  const sshPassword = process.env.NAS_SSH_PASSWORD ?? "";
  const nasBase     = (customer.nasPath ?? "/rtpulse").replace(/\/$/, "");
  const minioIp     = customer.vip ?? customer.ip ?? new URL(customer.apiUrl).hostname;
  const minioKey    = process.env.MINIO_ACCESS_KEY ?? "";
  const minioSecret = process.env.MINIO_SECRET_KEY ?? "";

  if (!sshPassword)
    return NextResponse.json({ error: "NAS_SSH_PASSWORD 환경변수가 설정되지 않았습니다." }, { status: 500 });
  if (!minioKey || !minioSecret)
    return NextResponse.json({ error: "MINIO_ACCESS_KEY / MINIO_SECRET_KEY 환경변수가 설정되지 않았습니다." }, { status: 500 });

  const { events, nasSubPath } = (await req.json()) as { events: UploadEvent[]; nasSubPath: string };
  if (!events?.length)
    return NextResponse.json({ error: "업로드할 항목을 선택하세요." }, { status: 400 });

  // MinIO 연결 확인 (빠른 실패)
  let minio: MinioClient;
  try {
    minio = await resolveMinioClient(minioIp, minioKey, minioSecret);
  } catch (e) {
    return NextResponse.json(
      { error: `MinIO 연결 실패 (${minioIp}): ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const subPath   = (nasSubPath ?? "").replace(/^\//, "").replace(/\/$/, "");
  const targetDir = subPath ? `${nasBase}/${subPath}` : nasBase;
  const thumbDir  = `${targetDir}/thumbnail`;
  const videoDir  = `${targetDir}/video`;

  // 라벨(TP/FP 등) 조회 — 파일명에 반영. file_name = {cam}_{event}_{YYYYMMDD}_{HHMMSS}
  const labelMap: Record<string, string> = {};
  try {
    await initDb();
    const { rows } = await getPool().query<{ file_name: string; result: string }>(
      "SELECT file_name, result FROM detection_results WHERE customer_id = $1 AND result IS NOT NULL",
      [customerId],
    );
    for (const r of rows) labelMap[r.file_name] = r.result;
  } catch { /* 라벨 조회 실패해도 업로드는 진행(라벨 없이) */ }

  // 잡 생성 & 백그라운드 시작
  const jobId = createJob();
  const nasPort = Number(process.env.NAS_SSH_PORT ?? 22);

  // fire-and-forget (응답 반환 후 계속 실행됨)
  runUploadJob(jobId, minio, nasHost, sshUser, sshPassword, nasPort, events, thumbDir, videoDir, targetDir, labelMap)
    .catch((e) => failJob(jobId, e instanceof Error ? e.message : String(e)));

  return NextResponse.json({ jobId, status: "processing" });
}
