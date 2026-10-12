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

/** "20260420_055532" -> "2026-04-20 05:55:32" */
function parseTs(ts: string): string {
  const d = ts.replace("_", "");
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${d.slice(8,10)}:${d.slice(10,12)}:${d.slice(12,14)}`;
}

function parseFileName(name: string): { cameraId: string; eventName: string; startTime: string } | null {
  const noExt = name.replace(/\.[^.]+$/, "");
  const m = noExt.match(/^(.+)_(\d{8}_\d{6})$/);
  if (!m) return null;
  const rest = m[1];
  const ts   = m[2];
  const idx  = rest.indexOf("_");
  if (idx === -1) return null;
  return {
    cameraId:  rest.slice(0, idx),
    eventName: rest.slice(idx + 1),
    startTime: parseTs(ts),
  };
}

/**
 * POST /api/nas/{customerId}/upload-chunk
 *
 * 대용량 영상 파일을 5MB 단위 청크로 분할 업로드합니다.
 * chunkIndex=0 → 'w' (새로 쓰기), chunkIndex>0 → 'a' (이어쓰기)
 * 마지막 청크(chunkIndex === totalChunks-1)에서 nas_uploads DB 기록
 *
 * Body: {
 *   fileName: string       // "5_smoke_20260418_000002.mp4"
 *   subPath: string        // "customer-x"
 *   chunkIndex: number     // 0-based
 *   totalChunks: number
 *   fileSize: number       // 전체 파일 크기(bytes)
 *   data: string           // base64 chunk data
 * }
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

  // Raw body stream 읽기 (req.json()은 10MB 한계로 대용량 실패)
  let body: {
    fileName?: string;
    subPath?: string;
    chunkIndex?: number;
    totalChunks?: number;
    fileSize?: number;
    data?: string;
  };
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

  const {
    fileName,
    subPath    = "",
    chunkIndex = 0,
    totalChunks = 1,
    fileSize   = 0,
    data,
  } = body;

  if (!fileName || !data) {
    return NextResponse.json({ error: "fileName, data 필수" }, { status: 400 });
  }

  const buffer        = Buffer.from(data, "base64");
  const normalizedSub = subPath.replace(/^\//, "").replace(/\/$/, "");
  const targetDir     = normalizedSub ? `${nasBase}/${normalizedSub}` : nasBase;
  const videoDir      = `${targetDir}/video`;
  const remotePath    = `${videoDir}/${fileName}`;
  const isLastChunk   = chunkIndex === totalChunks - 1;

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

        try {
          // 첫 청크: 디렉토리 생성
          if (chunkIndex === 0) {
            await sftpMkdirP(sftp, videoDir);
          }

          // 첫 청크 → 새 파일 쓰기('w'), 이후 → 이어쓰기('a')
          const flags = chunkIndex === 0 ? "w" : "a";
          await new Promise<void>((res, rej) => {
            const ws = sftp.createWriteStream(remotePath, { flags });
            let settled = false;
            const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
            ws.on("error", (e: Error) => done(() => rej(e)));
            ws.on("close",  ()         => done(() => res()));
            ws.end(buffer);
          });

          // 마지막 청크: DB 기록
          if (isLastChunk) {
            await initDb();
            const pool   = getPool();
            const parsed = parseFileName(fileName);
            const totalSize = fileSize || buffer.byteLength;
            await pool.query(
              `INSERT INTO nas_uploads
                 (customer_id, file_name, sub_path, file_type, nas_path,
                  size_bytes, camera_id, event_name, start_time, uploaded_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (customer_id, nas_path) DO UPDATE
                 SET size_bytes  = EXCLUDED.size_bytes,
                     uploaded_at = EXCLUDED.uploaded_at`,
              [
                customerId, fileName, normalizedSub, "video", remotePath,
                totalSize,
                parsed?.cameraId  ?? null,
                parsed?.eventName ?? null,
                parsed?.startTime ?? null,
                new Date().toISOString(),
              ]
            );
          }

          conn.end();
          safeResolve(NextResponse.json({ ok: true, chunkIndex, totalChunks, fileName, isLastChunk }));
        } catch (e: unknown) {
          conn.end();
          safeResolve(NextResponse.json(
            { error: `청크 쓰기 실패: ${e instanceof Error ? e.message : String(e)}` },
            { status: 502 }
          ));
        }
      });
    });

    conn.on("error",   (err) => safeResolve(NextResponse.json({ error: `SSH 연결 실패: ${err.message}` }, { status: 502 })));
    conn.on("timeout", ()    => safeResolve(NextResponse.json({ error: "SSH 연결 시간 초과" },             { status: 504 })));

    conn.connect({
      host:               nasHost,
      port:               Number(process.env.NAS_SSH_PORT ?? 22),
      username:           sshUser,
      password:           sshPassword,
      readyTimeout:       30_000,
      keepaliveInterval:  10_000,
      keepaliveCountMax:  60,
    });
  });
}
