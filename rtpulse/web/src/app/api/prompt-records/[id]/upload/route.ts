/**
 * POST /api/prompt-records/[id]/upload
 *
 * 기존 레코드(id)에 JSON 또는 CSV 파일을 스트리밍으로 업로드합니다.
 * 파일을 메모리에 버퍼링하지 않고 NAS SFTP로 직접 스트리밍합니다.
 *
 * NAS 저장 경로:
 *   JSON → {NAS_PROMPT_BASE}/{version}/text_features_{version}.json
 *   CSV  → {NAS_PROMPT_BASE}/{version}/text_features_{version}.csv
 */
import { type NextRequest, NextResponse } from "next/server";
import { Client as SshClient, type SFTPWrapper } from "ssh2";
import { Readable } from "stream";
import Busboy from "busboy";
import { getPool, initDb } from "@/lib/db";
import { updatePromptNasPath, updatePromptCsvPath } from "@/lib/prompt-records";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const NAS_HOST = () => process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
const NAS_USER = () => process.env.NAS_SSH_USER     ?? "ops";
const NAS_PASS = () => process.env.NAS_SSH_PASSWORD ?? "";
const NAS_PORT = () => Number(process.env.NAS_SSH_PORT ?? 22);
const NAS_BASE = () => (process.env.NAS_PROMPT_BASE ?? "/rtpulse/prompts").replace(/\/$/, "");

function connectSftp() {
  return new Promise<{ sftp: SFTPWrapper; conn: SshClient }>((resolve, reject) => {
    const c = new SshClient();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { c.destroy(); } catch { /**/ } reject(new Error("SSH/SFTP 연결 시간 초과 (8s)")); }
    }, 8_000);

    const fail = (e: Error) => {
      if (!settled) { settled = true; clearTimeout(timer); try { c.destroy(); } catch { /**/ } reject(e); }
    };

    c.on("error", fail);
    c.on("timeout", () => fail(new Error("SSH 연결 시간 초과")));
    c.on("ready", () => {
      c.sftp((err, sftp) => {
        if (err) { fail(err); return; }
        if (!settled) {
          settled = true; clearTimeout(timer);
          sftp.on("error", () => { /**/ });
          resolve({ sftp, conn: c });
        }
      });
    });
    c.connect({ host: NAS_HOST(), port: NAS_PORT(), username: NAS_USER(), password: NAS_PASS(), readyTimeout: 6_000, keepaliveInterval: 10_000 });
  });
}

function sftpMkdirP(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const parts = remotePath.split("/").filter(Boolean);
  let current = "";
  return parts.reduce(
    (p, part) => p.then(() => new Promise<void>((res) => { current += "/" + part; sftp.mkdir(current, () => res()); })),
    Promise.resolve()
  );
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  if (!NAS_PASS()) return NextResponse.json({ error: "NAS_SSH_PASSWORD 환경변수 미설정" }, { status: 500 });

  // DB에서 version 조회
  await initDb();
  const { rows } = await getPool().query(`SELECT version FROM prompts WHERE id = $1`, [numId]);
  if (rows.length === 0) return NextResponse.json({ error: "레코드를 찾을 수 없습니다." }, { status: 404 });
  const { version } = rows[0] as { version: string };

  const safeVersion = version.replace(/[/\\:*?"<>|]/g, "_");
  const dir = `${NAS_BASE()}/${safeVersion}`;

  const contentType = req.headers.get("content-type") ?? "";

  return new Promise<NextResponse>((resolve) => {
    const bb = Busboy({ headers: { "content-type": contentType } });
    let handled = false;
    let fileFound = false;
    // 클라이언트 연결 끊김 시 열린 SSH 연결 즉시 정리
    const openConns: SshClient[] = [];

    const fail = (msg: string, status = 502) => {
      if (!handled) {
        handled = true;
        // 열린 SSH 연결 모두 즉시 종료 → 대용량 스트리밍 중단
        for (const c of openConns) { try { c.destroy(); } catch { /**/ } }
        resolve(NextResponse.json({ error: msg }, { status }));
      }
    };

    bb.on("file", (fieldname, fileStream, info) => {
      if (fieldname !== "file") { fileStream.resume(); return; }
      fileFound = true;

      const isCsv  = info.filename.toLowerCase().endsWith(".csv");
      const ext    = isCsv ? "csv" : "json";
      const nasPath = `${dir}/text_features_${safeVersion}.${ext}`;

      connectSftp()
        .then(({ sftp, conn }) => {
          // abort 시 연결 정리를 위해 추적
          openConns.push(conn);

          sftpMkdirP(sftp, dir)
            .then(() => {
              // highWaterMark 상향: ssh2가 다수 WRITE를 파이프라인 → 처리량 대폭 향상
              const ws = sftp.createWriteStream(nasPath, { highWaterMark: 2 * 1024 * 1024 });

              ws.on("error", (e: Error) => {
                const idx = openConns.indexOf(conn);
                if (idx !== -1) openConns.splice(idx, 1);
                try { conn.end(); } catch { /**/ }
                if (!handled) { handled = true; resolve(NextResponse.json({ error: `NAS 쓰기 오류: ${e.message}` }, { status: 502 })); }
              });

              ws.on("close", async () => {
                const idx = openConns.indexOf(conn);
                if (idx !== -1) openConns.splice(idx, 1);
                try { conn.end(); } catch { /**/ }
                try {
                  if (isCsv) await updatePromptCsvPath(numId, nasPath);
                  else       await updatePromptNasPath(numId, nasPath);
                  if (!handled) { handled = true; resolve(NextResponse.json({ ok: true, nas_path: nasPath, type: ext })); }
                } catch (e) {
                  if (!handled) { handled = true; resolve(NextResponse.json({ error: `DB 업데이트 실패: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 })); }
                }
              });

              // abort 시 uncaughtException 방지
              fileStream.on("error", (e: Error) => {
                fail(`파일 스트림 오류: ${e.message}`, 499);
              });

              fileStream.pipe(ws);
            })
            .catch((e) => {
              const idx = openConns.indexOf(conn);
              if (idx !== -1) openConns.splice(idx, 1);
              try { conn.end(); } catch { /**/ }
              if (!handled) { handled = true; resolve(NextResponse.json({ error: `NAS 디렉토리 생성 실패: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 })); }
            });
        })
        .catch((e) => {
          fail(`NAS 연결 실패: ${e instanceof Error ? e.message : String(e)}`);
        });
    });

    bb.on("error", (e) => {
      fail(`파일 파싱 실패: ${e instanceof Error ? e.message : String(e)}`, 400);
    });

    bb.on("finish", () => {
      // fileFound=true이면 SFTP 업로드가 진행 중 → ws.on("close")가 resolve 담당
      if (!handled && !fileFound) {
        handled = true;
        resolve(NextResponse.json({ error: "파일을 선택하세요." }, { status: 400 }));
      }
    });

    // req.signal: 실제 클라이언트 연결 끊김만 감지 (readable.on("close")는 정상 완료 시에도 발생)
    req.signal.addEventListener("abort", () => fail("클라이언트가 연결을 끊었습니다.", 499));

    // Web ReadableStream → Node.js Readable → busboy
    const readable = Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]);
    // 스트림 오류(ECONNRESET 등) 처리
    readable.on("error", () => fail("클라이언트 연결이 끊겼습니다.", 499));
    readable.pipe(bb);
  });
}
