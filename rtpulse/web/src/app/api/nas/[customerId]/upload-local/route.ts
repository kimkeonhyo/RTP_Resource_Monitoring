import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getPool, initDb } from "@/lib/db";
import { Client as SshClient, SFTPWrapper } from "ssh2";

type Params = { params: Promise<{ customerId: string }> };

/** SFTP mkdir -p */
async function sftpMkdirP(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const parts = remotePath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    await new Promise<void>((resolve) => sftp.mkdir(current, () => resolve()));
  }
}

/** Buffer -> SFTP 스트림 업로드 */
function sftpWriteBuffer(sftp: SFTPWrapper, buffer: Buffer, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const writeStream = sftp.createWriteStream(remotePath);
    let settled = false;
    const done  = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    writeStream.on("error",   (e: Error) => done(() => reject(e)));
    writeStream.on("timeout", ()  => done(() => reject(new Error("stream timeout"))));
    writeStream.on("close",   ()  => done(() => resolve()));
    writeStream.end(buffer);
  });
}

/** "20260420_055532" -> "2026-04-20 05:55:32" */
function parseTs(ts: string): string {
  const d = ts.replace("_", "");
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${d.slice(8,10)}:${d.slice(10,12)}:${d.slice(12,14)}`;
}

/** 파일명에서 cameraId / eventName / startTime 추출 */
function parseFileName(name: string): { cameraId: string; eventName: string; startTime: string } | null {
  const noExt = name.replace(/\.[^.]+$/, "");
  const m = noExt.match(/^(.+)_(\d{8}_\d{6})$/);
  if (!m) return null;
  const rest = m[1];
  const ts   = m[2];
  const underscoreIdx = rest.indexOf("_");
  if (underscoreIdx === -1) return null;
  return {
    cameraId:  rest.slice(0, underscoreIdx),
    eventName: rest.slice(underscoreIdx + 1),
    startTime: parseTs(ts),
  };
}

/**
 * POST /api/nas/{customerId}/upload-local
 * Content-Type: application/json
 * Body: { subPath: string, files: Array<{ name: string, data: string (base64) }> }
 *
 * 로컬 파일을 NAS에 저장하고 nas_uploads 테이블에 기록합니다.
 * .jpg/.jpeg/.png -> thumbnail/, .mp4 -> video/
 *
 * (req.formData() 대신 JSON+base64 방식 사용 — Next.js multipart 파싱 한계 우회)
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const nasHost     = process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
  const sshUser     = process.env.NAS_SSH_USER     ?? "ops";
  const sshPassword = process.env.NAS_SSH_PASSWORD ?? "";
  const nasBase     = (customer.nasPath ?? "/rtpulse").replace(/\/$/, "");

  if (!sshPassword) {
    return NextResponse.json({ error: "NAS_SSH_PASSWORD 환경변수가 설정되지 않았습니다." }, { status: 500 });
  }

  // req.json()은 내부 10MB 한계로 대용량에서 "Unterminated string" 오류 발생
  // → req.body ReadableStream을 직접 읽어 JSON.parse (serverBodySizeLimit 200mb 적용됨)
  let body: { subPath?: string; files?: Array<{ name: string; data: string }> };
  try {
    if (!req.body) throw new Error("요청 body가 없습니다.");
    const chunks: Buffer[] = [];
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `요청 파싱 실패: ${detail}` }, { status: 400 });
  }

  const subPath    = body.subPath ?? "";
  const fileItems  = body.files   ?? [];

  if (fileItems.length === 0) {
    return NextResponse.json({ error: "업로드할 파일이 없습니다." }, { status: 400 });
  }

  const normalizedSub = subPath.replace(/^\//, "").replace(/\/$/, "");
  const targetDir = normalizedSub ? `${nasBase}/${normalizedSub}` : nasBase;
  const thumbDir  = `${targetDir}/thumbnail`;
  const videoDir  = `${targetDir}/video`;

  // base64 → Buffer 변환 및 분류
  // webkitdirectory 사용 시 name에 상대 경로가 포함될 수 있음
  // 예: "test/video/186_smoke_20260420_231050.mp4"
  const fileBuffers: {
    baseName: string; buffer: Buffer; isVideo: boolean; size: number;
  }[] = [];

  for (const { name, data } of fileItems) {
    const baseName = name.includes("/")
      ? (name.split("/").pop() ?? name)
      : name;

    if (baseName.startsWith(".")) continue;

    const pathLower  = name.toLowerCase();
    const inVideoDir = /\/video\/|\/videos\//i.test(pathLower) || /^video\//i.test(pathLower);
    const inThumbDir = /\/thumbnail\/|\/thumbnails\/|\/thumb\//i.test(pathLower) || /^thumbnail\//i.test(pathLower);
    const isVideoExt = /\.(mp4|mov|avi|mkv)$/i.test(baseName);
    const isThumbExt = /\.(jpg|jpeg|png|webp)$/i.test(baseName);

    if (!isVideoExt && !isThumbExt) continue;

    const isVideo = inVideoDir ? true : inThumbDir ? false : isVideoExt;
    const buffer  = Buffer.from(data, "base64");
    fileBuffers.push({ baseName, buffer, isVideo, size: buffer.byteLength });
  }

  await initDb();
  const pool = getPool();

  return new Promise<NextResponse>((resolve) => {
    const conn = new SshClient();
    let resolved = false;
    const safeResolve = (r: NextResponse) => { if (!resolved) { resolved = true; resolve(r); } };

    conn.on("ready", () => {
      conn.sftp(async (err, sftp) => {
        if (err) {
          conn.end();
          safeResolve(NextResponse.json({ error: `SFTP 실패: ${err.message}` }, { status: 502 }));
          return;
        }

        await sftpMkdirP(sftp, thumbDir);
        await sftpMkdirP(sftp, videoDir);

        let uploaded = 0;
        const errors: string[] = [];
        const uploadedAt = new Date().toISOString();

        for (const { baseName, buffer, isVideo, size } of fileBuffers) {
          const dir        = isVideo ? videoDir : thumbDir;
          const remotePath = `${dir}/${baseName}`;
          const fileType   = isVideo ? "video" : "thumbnail";

          try {
            await sftpWriteBuffer(sftp, buffer, remotePath);

            const parsed = parseFileName(baseName);
            await pool.query(
              `INSERT INTO nas_uploads
                 (customer_id, file_name, sub_path, file_type, nas_path,
                  size_bytes, camera_id, event_name, start_time, uploaded_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (customer_id, nas_path) DO UPDATE
                 SET size_bytes  = EXCLUDED.size_bytes,
                     uploaded_at = EXCLUDED.uploaded_at`,
              [
                customerId, baseName, normalizedSub, fileType, remotePath,
                size,
                parsed?.cameraId  ?? null,
                parsed?.eventName ?? null,
                parsed?.startTime ?? null,
                uploadedAt,
              ]
            );

            uploaded++;
          } catch (e: unknown) {
            errors.push(`${baseName}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        conn.end();
        safeResolve(
          NextResponse.json({
            ok: true,
            uploaded,
            total: fileBuffers.length,
            errors: errors.length > 0 ? errors : undefined,
            targetDir,
            subPath: normalizedSub,
          })
        );
      });
    });

    conn.on("error",   (err) => safeResolve(NextResponse.json({ error: `SSH 연결 실패: ${err.message}` },  { status: 502 })));
    conn.on("timeout", ()    => safeResolve(NextResponse.json({ error: "SSH 연결 시간 초과" },              { status: 504 })));

    conn.connect({
      host:         nasHost,
      port:         Number(process.env.NAS_SSH_PORT ?? 22),
      username:     sshUser,
      password:     sshPassword,
      readyTimeout: 10_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 30,
    });
  });
}
