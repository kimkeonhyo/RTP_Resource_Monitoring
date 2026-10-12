/**
 * GET /api/prompt-records/download?path=/rtpulse/prompts/...
 *
 * NAS 파일을 SFTP로 읽어 브라우저 다운로드로 스트리밍합니다.
 *
 * [중요] 버퍼링 방식(전체를 메모리에 올린 후 전송) 대신
 * SFTP ReadStream → Web ReadableStream 직접 파이프 방식을 사용합니다.
 *
 * backpressure: controller.desiredSize ≤ 0 이면 sftp 스트림을 pause,
 * pull() 콜백에서 resume → Node.js 힙에 데이터가 쌓이지 않습니다.
 */
import { NextRequest, NextResponse } from "next/server";
import { Client as SshClient, SFTPWrapper } from "ssh2";
import type { Readable } from "stream";

export const runtime = "nodejs";

const NAS_HOST = () => process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
const NAS_USER = () => process.env.NAS_SSH_USER     ?? "ops";
const NAS_PASS = () => process.env.NAS_SSH_PASSWORD ?? "";
const NAS_PORT = () => Number(process.env.NAS_SSH_PORT ?? 22);

async function connectSftp(): Promise<{ sftp: SFTPWrapper; conn: SshClient }> {
  return new Promise<{ sftp: SFTPWrapper; conn: SshClient }>((resolve, reject) => {
    const c = new SshClient();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { c.destroy(); } catch { /* ignore */ }
        reject(new Error("SSH/SFTP 연결 시간 초과 (8s)"));
      }
    }, 8_000);

    const fail = (e: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { c.destroy(); } catch { /* ignore */ }
        reject(e);
      }
    };

    c.on("error",   (e) => fail(e));
    c.on("timeout", ()  => fail(new Error("SSH 연결 시간 초과")));
    c.on("ready", () => {
      c.sftp((err, sftp) => {
        if (err) { fail(err); return; }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          sftp.on("error", () => { /* post-close error 무시 */ });
          resolve({ sftp, conn: c });
        }
      });
    });
    c.connect({
      host:              NAS_HOST(),
      port:              NAS_PORT(),
      username:          NAS_USER(),
      password:          NAS_PASS(),
      readyTimeout:      6_000,
      keepaliveInterval: 10_000,
    });
  });
}

/** sftp.stat()으로 파일 크기 조회. 파일이 없으면 null 반환 */
function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => {
      resolve(err ? null : stats.size);
    });
  });
}

export async function GET(req: NextRequest) {
  if (!NAS_PASS()) {
    return NextResponse.json({ error: "NAS_SSH_PASSWORD 환경변수 미설정" }, { status: 500 });
  }

  const nasPath = req.nextUrl.searchParams.get("path");
  if (!nasPath || !nasPath.startsWith("/")) {
    return NextResponse.json({ error: "유효하지 않은 path 파라미터" }, { status: 400 });
  }

  let conn: SshClient | null = null;
  try {
    const { sftp, conn: c } = await connectSftp();
    conn = c;

    // 파일 존재 확인 + 크기 조회
    const fileSize = await sftpStat(sftp, nasPath);
    if (fileSize === null) {
      try { c.end(); } catch { /* ignore */ }
      console.warn("[prompt-download] file not found on NAS:", nasPath);
      return NextResponse.json({ error: "NAS에서 파일을 찾을 수 없습니다." }, { status: 404 });
    }

    const fileName    = nasPath.split("/").pop() ?? "prompt.json";
    const isCsv      = fileName.toLowerCase().endsWith(".csv");
    const contentType = isCsv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";

    // SFTP ReadStream → Web ReadableStream (backpressure 지원)
    // controller.desiredSize ≤ 0 이면 pause, pull()에서 resume
    let sftpStream: Readable | null = null;

    const readable = new ReadableStream({
      start(controller) {
        sftpStream = sftp.createReadStream(nasPath);

        sftpStream.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
          // 내부 큐가 가득 차면 sftp 스트림 일시 중단 → 메모리 누적 방지
          if ((controller.desiredSize ?? 1) <= 0) {
            sftpStream!.pause();
          }
        });

        sftpStream.on("end", () => {
          controller.close();
          try { c.end(); } catch { /* ignore */ }
        });

        sftpStream.on("error", (err: Error) => {
          console.error("[prompt-download] SFTP read error:", nasPath, err.message);
          controller.error(err);
          try { c.end(); } catch { /* ignore */ }
        });
      },
      pull() {
        // 소비자가 데이터를 더 원할 때 sftp 스트림 재개
        sftpStream?.resume();
      },
      cancel() {
        try { sftpStream?.destroy(); } catch { /* ignore */ }
        try { c.end(); } catch { /* ignore */ }
      },
    });

    const headers: Record<string, string> = {
      "Content-Type":        contentType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      "Cache-Control":       "no-store",
      "Content-Length":      String(fileSize),
    };

    return new NextResponse(readable, { headers });
  } catch (e) {
    try { conn?.end(); } catch { /* ignore */ }
    console.error("[prompt-download] error:", e);
    return NextResponse.json(
      { error: `다운로드 실패: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
