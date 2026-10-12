import { NextRequest, NextResponse } from "next/server";
import { Client as SshClient, SFTPWrapper } from "ssh2";
import { deletePrompt, clearPromptFilePath } from "@/lib/prompt-records";
import { getPool, initDb } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// ── SFTP 헬퍼 ────────────────────────────────────────────────────────────────

const NAS_HOST = () => process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
const NAS_USER = () => process.env.NAS_SSH_USER     ?? "ops";
const NAS_PASS = () => process.env.NAS_SSH_PASSWORD ?? "";
const NAS_PORT = () => Number(process.env.NAS_SSH_PORT ?? 22);

async function connectSftp(): Promise<{ sftp: SFTPWrapper; conn: SshClient }> {
  return new Promise((resolve, reject) => {
    const c = new SshClient();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { c.destroy(); } catch { /* ignore */ } reject(new Error("SFTP 연결 시간 초과 (8s)")); }
    }, 8_000);

    const fail = (e: Error) => {
      if (!settled) { settled = true; clearTimeout(timer); try { c.destroy(); } catch { /* ignore */ } reject(e); }
    };

    c.on("error", fail);
    c.on("timeout", () => fail(new Error("SSH 연결 시간 초과")));
    c.on("ready", () => {
      c.sftp((err, sftp) => {
        if (err) { fail(err); return; }
        if (!settled) {
          settled = true; clearTimeout(timer);
          sftp.on("error", () => { /* ignore post-close errors */ });
          resolve({ sftp, conn: c });
        }
      });
    });
    c.connect({ host: NAS_HOST(), port: NAS_PORT(), username: NAS_USER(), password: NAS_PASS(), readyTimeout: 6_000 });
  });
}

function sftpUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve()));
  });
}

// ── PATCH — NAS 파일 삭제 + DB 경로 초기화 ───────────────────────────────────

/** PATCH /api/prompt-records/{id}
 *  body: { field: "nas_path" | "csv_path" }
 *  → NAS 실제 파일 삭제 후 DB 경로 NULL 초기화 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const field = body?.field;
  if (field !== "nas_path" && field !== "csv_path") {
    return NextResponse.json({ error: "field must be nas_path or csv_path" }, { status: 400 });
  }

  // 현재 저장된 NAS 경로 조회
  await initDb();
  const { rows } = await getPool().query(
    `SELECT ${field} AS file_path FROM prompts WHERE id = $1`, [numId]
  );
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filePath = (rows[0] as { file_path: string | null }).file_path;

  // NAS 파일 삭제 (경로가 있는 경우만 — 없으면 스킵)
  if (filePath) {
    let conn: SshClient | null = null;
    try {
      const { sftp, conn: c } = await connectSftp();
      conn = c;
      await sftpUnlink(sftp, filePath);
      conn.end();
    } catch (e) {
      // 파일이 이미 없거나 NAS 일시 불가인 경우 → 경고 로그만 남기고 DB 정리는 계속 진행
      console.warn("[prompt-records] NAS unlink warning (ignored):", e instanceof Error ? e.message : e);
      try { conn?.end(); } catch { /* ignore */ }
    }
  }

  // DB 경로 NULL 초기화
  try {
    await clearPromptFilePath(numId, field);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[prompt-records] clear file path error:", e);
    return NextResponse.json({ error: "DB 초기화 실패" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  try {
    await deletePrompt(numId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[prompt-records] delete error:", e);
    return NextResponse.json({ error: "삭제 실패" }, { status: 500 });
  }
}
