/**
 * POST /api/prompt-records/[id]/convert
 *
 * 이미 NAS에 저장된 CSV를 Flask PE-Core 서버로 보내 JSON으로 변환한 뒤,
 * 결과 JSON을 NAS에 자동 업로드하고 DB의 nas_path를 갱신합니다.
 *
 * 흐름:
 *   NAS CSV → (SFTP read) → Buffer → Flask /upload
 *   Flask download_url → (HTTP stream, 메모리 버퍼링 없음) → NAS JSON (SFTP write)
 *   → DB nas_path 갱신
 */
import { type NextRequest, NextResponse } from "next/server";
import { Client as SshClient, type SFTPWrapper } from "ssh2";
import { Readable } from "stream";
import { getPool, initDb } from "@/lib/db";
import { updatePromptNasPath } from "@/lib/prompt-records";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const NAS_HOST = () => process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
const NAS_USER = () => process.env.NAS_SSH_USER     ?? "ops";
const NAS_PASS = () => process.env.NAS_SSH_PASSWORD ?? "";
const NAS_PORT = () => Number(process.env.NAS_SSH_PORT ?? 22);
const NAS_BASE = () => (process.env.NAS_PROMPT_BASE ?? "/rtpulse/prompts").replace(/\/$/, "");
const EXTRACTOR_URL = () => (process.env.FEATURE_EXTRACTOR_URL ?? "").replace(/\/$/, "");

/* ── SFTP 유틸 ────────────────────────────────────────────────────────────── */

function connectSftp() {
  return new Promise<{ sftp: SFTPWrapper; conn: SshClient }>((resolve, reject) => {
    const c = new SshClient();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { c.destroy(); } catch { /**/ } reject(new Error("SSH 연결 시간 초과")); }
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

/** NAS의 파일을 Buffer로 읽어옵니다 (CSV는 크기가 작으므로 버퍼링 허용) */
function readNasFile(csvPath: string): Promise<Buffer> {
  return connectSftp().then(({ sftp, conn }) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(csvPath);
      stream.on("data",  (chunk: Buffer) => chunks.push(chunk));
      stream.on("end",   () => { try { conn.end(); } catch { /**/ } resolve(Buffer.concat(chunks)); });
      stream.on("error", (e: Error) => { try { conn.end(); } catch { /**/ } reject(e); });
    })
  );
}

/**
 * Web ReadableStream → NAS SFTP 스트리밍 저장 (메모리 버퍼링 없음)
 * Flask JSON 응답처럼 수백 MB가 될 수 있는 파일에 사용합니다.
 */
function streamResponseToNas(
  body: ReadableStream<Uint8Array>,
  nasPath: string,
  dir: string,
): Promise<void> {
  return connectSftp().then(({ sftp, conn }) =>
    sftpMkdirP(sftp, dir).then(() =>
      new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream(nasPath);
        ws.on("error", (e: Error) => { try { conn.end(); } catch { /**/ } reject(e); });
        ws.on("close", () => { try { conn.end(); } catch { /**/ } resolve(); });
        // Web ReadableStream → Node.js Readable → SFTP WriteStream (zero-copy streaming)
        Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).pipe(ws);
      })
    ).catch((e) => { try { conn.end(); } catch { /**/ } throw e; })
  );
}

/* ── POST handler ─────────────────────────────────────────────────────────── */

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  if (!NAS_PASS()) return NextResponse.json({ error: "NAS_SSH_PASSWORD 환경변수 미설정" }, { status: 500 });

  const extractorUrl = EXTRACTOR_URL();
  if (!extractorUrl) return NextResponse.json({ error: "FEATURE_EXTRACTOR_URL 환경변수 미설정" }, { status: 500 });

  // 1. DB에서 레코드 조회
  await initDb();
  const { rows } = await getPool().query(
    `SELECT version, csv_path FROM prompts WHERE id = $1`, [numId]
  );
  if (rows.length === 0) return NextResponse.json({ error: "레코드를 찾을 수 없습니다." }, { status: 404 });

  const { version, csv_path } = rows[0] as { version: string; csv_path: string | null };
  if (!csv_path) return NextResponse.json({ error: "CSV 파일이 없습니다. 먼저 CSV를 업로드하세요." }, { status: 400 });

  try {
    // 2. NAS에서 CSV 읽기 (버퍼 — CSV는 수 MB 이하)
    const csvBuffer = await readNasFile(csv_path);
    const csvFilename = csv_path.split("/").pop() ?? "data.csv";

    // 3. Flask /upload 로 전송
    const upstream = new FormData();
    upstream.append("csv_file", new Blob([new Uint8Array(csvBuffer)], { type: "text/csv" }), csvFilename);

    console.log(`[convert] Flask로 CSV 전송 중: ${extractorUrl}/upload (${csvBuffer.length} bytes)`);
    const uploadRes = await fetch(`${extractorUrl}/upload`, {
      method: "POST",
      body: upstream,
      signal: AbortSignal.timeout(1_800_000), // 30분 (ML 피처 추출은 시간이 오래 걸림)
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      console.error(`[convert] Flask 오류 ${uploadRes.status}:`, text);
      return NextResponse.json(
        { error: `Flask 서버 오류 (${uploadRes.status}): ${text}` },
        { status: 502 }
      );
    }

    const uploadJson = await uploadRes.json() as { download_url?: string; error?: string };
    console.log("[convert] Flask 응답:", uploadJson);
    if (!uploadJson.download_url) {
      return NextResponse.json(
        { error: `Flask 응답 이상: ${JSON.stringify(uploadJson)}` },
        { status: 502 }
      );
    }

    // 4. Flask download_url에서 JSON 스트리밍 다운로드
    // Flask가 상대경로("/download/xxx")를 반환하는 경우 절대 URL로 변환
    const rawUrl = uploadJson.download_url;
    const absoluteDownloadUrl = rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
      ? rawUrl
      : `${extractorUrl}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
    console.log("[convert] JSON 다운로드 중:", absoluteDownloadUrl);
    const jsonRes = await fetch(absoluteDownloadUrl, {
      signal: AbortSignal.timeout(1_800_000), // 30분
    });
    if (!jsonRes.ok) {
      return NextResponse.json(
        { error: `JSON 다운로드 실패 (${jsonRes.status})` },
        { status: 502 }
      );
    }
    if (!jsonRes.body) {
      return NextResponse.json({ error: "Flask JSON 응답 body가 비어 있습니다." }, { status: 502 });
    }

    // 5. JSON을 NAS에 스트리밍 저장 (메모리 버퍼링 없음 — OOM 방지)
    const safeVersion = version.replace(/[/\\:*?"<>|]/g, "_");
    const dir     = `${NAS_BASE()}/${safeVersion}`;
    const nasPath = `${dir}/text_features_${safeVersion}.json`;

    console.log("[convert] NAS에 JSON 스트리밍 저장 중:", nasPath);
    await streamResponseToNas(jsonRes.body, nasPath, dir);
    console.log("[convert] NAS 저장 완료:", nasPath);

    // 6. DB 갱신
    await updatePromptNasPath(numId, nasPath);

    return NextResponse.json({ ok: true, nas_path: nasPath });
  } catch (e) {
    console.error("[convert] error:", e);
    return NextResponse.json(
      { error: `변환 오류: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
