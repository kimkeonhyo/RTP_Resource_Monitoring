/**
 * POST /api/prompt-records/upload
 *
 * 파일을 메모리에 버퍼링하지 않고 NAS SFTP로 직접 스트리밍합니다.
 *
 * Body: multipart/form-data
 *   - jsonFile:     JSON 파일 (required)
 *   - csvFile:      CSV  파일 (optional)
 *   - projectName:  string
 *   - version:      string
 *   - assignees:    comma-separated names
 *   - appliedAt:    date string (optional)
 *   - basePrompt:   string (optional)
 *
 * NAS destination:
 *   JSON → {NAS_PROMPT_BASE}/{version}/text_features_{version}.json
 *   CSV  → {NAS_PROMPT_BASE}/{version}/text_features_{version}.csv
 *
 * ※ multipart/form-data 전송 순서: 텍스트 필드 → 파일 (브라우저 기본 동작)
 *    텍스트 필드가 파일보다 먼저 도착해야 NAS 경로를 결정할 수 있습니다.
 */
import { type NextRequest, NextResponse } from "next/server";
import { Client as SshClient, type SFTPWrapper } from "ssh2";
import { Readable } from "stream";
import Busboy from "busboy";
import { insertPrompt } from "@/lib/prompt-records";

export const runtime = "nodejs";

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

function streamToNas(fileStream: Readable, nasPath: string, dir: string, openConns?: SshClient[]): Promise<void> {
  return connectSftp().then(({ sftp, conn }) => {
    // abort 시 연결 정리를 위해 추적
    openConns?.push(conn);
    return sftpMkdirP(sftp, dir).then(() =>
      new Promise<void>((resolve, reject) => {
        // highWaterMark 상향: ssh2가 다수 WRITE를 파이프라인 → 처리량 대폭 향상
        const ws = sftp.createWriteStream(nasPath, { highWaterMark: 2 * 1024 * 1024 });
        ws.on("error", (e: Error) => { try { conn.end(); } catch { /**/ } reject(e); });
        ws.on("close", () => {
          // 추적 목록에서 제거
          if (openConns) { const i = openConns.indexOf(conn); if (i !== -1) openConns.splice(i, 1); }
          try { conn.end(); } catch { /**/ }
          resolve();
        });
        fileStream.pipe(ws);
      })
    ).catch((e) => { try { conn.end(); } catch { /**/ } throw e; });
  });
}

export async function POST(req: NextRequest) {
  if (!NAS_PASS()) {
    return NextResponse.json({ error: "NAS_SSH_PASSWORD 환경변수가 설정되지 않았습니다." }, { status: 500 });
  }

  const contentType = req.headers.get("content-type") ?? "";

  return new Promise<NextResponse>((resolve) => {
    const bb = Busboy({ headers: { "content-type": contentType } });

    // 텍스트 필드 수집 (파일보다 먼저 도착)
    const fields: Record<string, string> = {};

    // 파일 업로드 추적
    const uploads: Promise<void>[] = [];
    const openConns: SshClient[] = [];  // abort 시 정리용
    let jsonNasPath: string | null = null;
    let csvNasPath:  string | null = null;
    let hasJsonFile = false;
    let resolved = false;

    const fail = (msg: string, status = 502) => {
      if (!resolved) {
        resolved = true;
        // 열린 SSH 연결 모두 정리
        for (const conn of openConns) { try { conn.end(); } catch { /**/ } }
        resolve(NextResponse.json({ error: msg }, { status }));
      }
    };

    bb.on("field", (name, val) => { fields[name] = val.trim(); });

    bb.on("file", (fieldname, fileStream, info) => {
      // 지원하지 않는 필드명은 드레인
      if (fieldname !== "jsonFile" && fieldname !== "file" && fieldname !== "csvFile") {
        fileStream.resume();
        return;
      }

      const isCsvField = fieldname === "csvFile";
      const isCsvName  = info.filename.toLowerCase().endsWith(".csv");
      const isCsv      = isCsvField || isCsvName;

      const version = fields["version"];
      if (!version) {
        fileStream.resume();
        fail("version 필드가 파일보다 먼저 전송되어야 합니다.", 400);
        return;
      }

      const safeVersion = version.replace(/[/\\:*?"<>|]/g, "_");
      const dir         = `${NAS_BASE()}/${safeVersion}`;
      const ext         = isCsv ? "csv" : "json";
      const nasPath     = `${dir}/text_features_${safeVersion}.${ext}`;

      if (!isCsv) { jsonNasPath = nasPath; hasJsonFile = true; }
      else         { csvNasPath  = nasPath; }

      // fileStream 에러도 반드시 처리 (abort 시 uncaughtException 방지)
      fileStream.on("error", (e) => fail(`파일 스트림 오류: ${e instanceof Error ? e.message : String(e)}`));

      uploads.push(streamToNas(fileStream, nasPath, dir, openConns).catch((e) => {
        fail(`NAS 업로드 실패 (${ext}): ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }));
    });

    bb.on("error", (e) => fail(`파일 파싱 실패: ${e instanceof Error ? e.message : String(e)}`, 400));

    bb.on("finish", async () => {
      // 필드 검증
      const projectName = fields["projectName"];
      const version     = fields["version"];
      if (!hasJsonFile) { fail("JSON 파일을 선택하세요.", 400); return; }
      if (!projectName) { fail("프로젝트명을 입력하세요.", 400); return; }
      if (!version)     { fail("버전명을 입력하세요.", 400); return; }

      // 모든 업로드 완료 대기
      try {
        await Promise.all(uploads);
      } catch {
        return; // fail() already called inside upload promise
      }

      // DB 등록
      try {
        const record = await insertPrompt({
          project_name: projectName,
          version,
          assignees:   fields["assignees"]  ?? "",
          applied_at:  fields["appliedAt"]  || null,
          nas_path:    jsonNasPath,
          csv_path:    csvNasPath,
          base_prompt: fields["basePrompt"] || null,
        });
        if (!resolved) { resolved = true; resolve(NextResponse.json({ ok: true, record })); }
      } catch (e) {
        fail(`DB 등록 실패: ${e instanceof Error ? e.message : String(e)}`, 500);
      }
    });

    // req.signal: 실제 클라이언트 연결 끊김만 감지 (readable.on("close")는 정상 완료 시에도 발생)
    req.signal.addEventListener("abort", () => fail("클라이언트가 연결을 끊었습니다.", 499));

    const readable = Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]);
    // 스트림 오류(ECONNRESET 등) 처리
    readable.on("error", () => fail("클라이언트 연결이 끊겼습니다.", 499));
    readable.pipe(bb);
  });
}
