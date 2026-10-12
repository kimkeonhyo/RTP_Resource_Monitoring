import { NextRequest, NextResponse } from "next/server";
import { Client as SshClient, type SFTPWrapper } from "ssh2";
import { Readable } from "stream";
import { listPrompts, insertPrompt, updatePromptNasPath, updatePromptCsvPath } from "@/lib/prompt-records";
import { beginSyncJob, finishSyncJob, getSyncJob, isSyncRunning, patchSyncJob, pushSyncResult } from "@/lib/prompt-sync-job";
import { getActor, logAudit } from "@/lib/audit";

export const runtime = "nodejs";

const NOTION_API_KEY    = process.env.NOTION_API_KEY ?? "";
const NOTION_DB_ID      = process.env.NOTION_PROMPT_DB_ID ?? "";
const EXTRACTOR_URL     = () => (process.env.FEATURE_EXTRACTOR_URL ?? "").replace(/\/$/, "");
const HF_TOKEN          = () => process.env.HUGGINGFACE_TOKEN ?? "";
const NAS_HOST          = () => process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
const NAS_USER          = () => process.env.NAS_SSH_USER     ?? "ops";
const NAS_PASS          = () => process.env.NAS_SSH_PASSWORD ?? "";
const NAS_PORT          = () => Number(process.env.NAS_SSH_PORT ?? 22);
const NAS_BASE          = () => (process.env.NAS_PROMPT_BASE ?? "/rtpulse/prompts").replace(/\/$/, "");

/** HuggingFace blob URL → raw download URL */
function toHfRawUrl(blobUrl: string): string {
  return blobUrl.replace(
    /huggingface\.co\/(.+?)\/blob\//,
    "huggingface.co/$1/resolve/",
  );
}

/** SFTP 연결 */
function connectSftp() {
  return new Promise<{ sftp: SFTPWrapper; conn: SshClient }>((resolve, reject) => {
    const c = new SshClient();
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; c.destroy(); reject(new Error("SSH 연결 시간 초과")); } }, 10_000);
    c.on("error", e => { if (!settled) { settled = true; clearTimeout(timer); c.destroy(); reject(e); } });
    c.on("ready", () => {
      c.sftp((err, sftp) => {
        if (err) { c.destroy(); reject(err); return; }
        if (!settled) { settled = true; clearTimeout(timer); resolve({ sftp, conn: c }); }
      });
    });
    c.connect({ host: NAS_HOST(), port: NAS_PORT(), username: NAS_USER(), password: NAS_PASS(), readyTimeout: 8_000 });
  });
}

function sftpMkdirP(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const parts = remotePath.split("/").filter(Boolean);
  let current = "";
  return parts.reduce(
    (p, part) => p.then(() => new Promise<void>(res => { current += "/" + part; sftp.mkdir(current, () => res()); })),
    Promise.resolve(),
  );
}

async function uploadBufToNas(buf: Buffer, nasPath: string): Promise<void> {
  await uploadToNas(Readable.from(buf), nasPath);
}

/** 웹 ReadableStream(예: fetch 응답 본문)을 버퍼링 없이 NAS로 직접 스트리밍 업로드. */
async function uploadWebStreamToNas(web: ReadableStream<Uint8Array>, nasPath: string): Promise<void> {
  // 큰 JSON을 메모리에 통째로 담지 않도록 fetch 본문 스트림을 그대로 흘려보냄
  await uploadToNas(Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]), nasPath);
}

/** Node Readable을 NAS(SFTP)로 스트리밍 업로드. */
async function uploadToNas(source: Readable, nasPath: string): Promise<void> {
  const dir = nasPath.split("/").slice(0, -1).join("/");
  const { sftp, conn } = await connectSftp();
  try {
    await sftpMkdirP(sftp, dir);
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(nasPath);
      ws.on("error", reject);
      ws.on("close", resolve);
      source.on("error", reject);
      source.pipe(ws);
    });
  } finally {
    conn.end();
  }
}

/** HuggingFace에서 CSV 원본 다운로드 (private 레포는 HUGGINGFACE_TOKEN 필요). 실패 시 null. */
async function downloadHfCsv(hfUrl: string, version: string): Promise<Buffer | null> {
  try {
    const rawUrl = toHfRawUrl(hfUrl);
    const csvRes = await fetch(rawUrl, {
      headers: HF_TOKEN() ? { Authorization: `Bearer ${HF_TOKEN()}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (!csvRes.ok) {
      console.warn(`[notion-sync] ${version}: HF CSV 다운로드 실패 (HTTP ${csvRes.status}) ${rawUrl}`);
      return null;
    }
    return Buffer.from(await csvRes.arrayBuffer());
  } catch (e) {
    console.warn(`[notion-sync] ${version}: HF CSV 다운로드 예외 — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** CSV Buffer → Flask 피처추출 → JSON 응답 스트림. 실패 시 null.
 *  큰 JSON을 메모리에 담지 않도록 fetch 본문 스트림을 그대로 반환한다. */
async function convertViaFlask(csvBuf: Buffer, version: string): Promise<ReadableStream<Uint8Array> | null> {
  const extractorUrl = EXTRACTOR_URL();
  if (!extractorUrl) {
    console.warn(`[notion-sync] ${version}: FEATURE_EXTRACTOR_URL 미설정 — 변환 스킵`);
    return null;
  }
  try {
    const form = new FormData();
    form.append("csv_file", new Blob([new Uint8Array(csvBuf)], { type: "text/csv" }), `text_features_${version}.csv`);
    const uploadRes = await fetch(`${extractorUrl}/upload`, {
      method: "POST", body: form, signal: AbortSignal.timeout(1_800_000), // 30분 (ML 피처추출)
    });
    if (!uploadRes.ok) {
      const detail = await uploadRes.text().catch(() => "");
      console.warn(`[notion-sync] ${version}: Flask 변환 실패 (HTTP ${uploadRes.status}) ${detail.slice(0, 200)}`);
      return null;
    }
    const uploadJson = await uploadRes.json() as { download_url?: string };
    if (!uploadJson.download_url) {
      console.warn(`[notion-sync] ${version}: Flask 응답에 download_url 없음`);
      return null;
    }
    // Flask가 상대경로("/download/xxx")를 반환하면 extractorUrl 기준 절대 URL로 변환
    const dl = uploadJson.download_url;
    const absDl = dl.startsWith("http://") || dl.startsWith("https://")
      ? dl
      : `${extractorUrl}${dl.startsWith("/") ? "" : "/"}${dl}`;
    const dlUrl = absDl.includes("?") ? `${absDl}&mode=with_prompt` : `${absDl}?mode=with_prompt`;
    const jsonRes = await fetch(dlUrl, { signal: AbortSignal.timeout(300_000) }); // 5분
    if (!jsonRes.ok || !jsonRes.body) {
      console.warn(`[notion-sync] ${version}: 변환 JSON 다운로드 실패 (HTTP ${jsonRes.status}) ${dlUrl}`);
      return null;
    }
    return jsonRes.body; // 버퍼링 없이 스트림 반환 (NAS로 직접 파이프)
  } catch (e) {
    console.warn(`[notion-sync] ${version}: 변환 예외 — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function GET() {
  try {
    const records = await listPrompts();
    return NextResponse.json(records);
  } catch (e) {
    console.error("[prompt-records] list error:", e);
    return NextResponse.json({ error: "DB 조회 실패" }, { status: 500 });
  }
}

/**
 * POST /api/prompt-records?csv=1&json=1
 * Notion 동기화를 **백그라운드 작업**으로 시작하고 즉시 반환한다. 진행 상황은
 * GET /api/prompt-records/sync-status 로 폴링한다. (긴 요청/스트리밍을 없애
 * LB·프록시 타임아웃과 무관하게 완주 — 근본 개선)
 * 옵션(csv/json, 기본 둘 다 on):
 *   - csv=1: HF CSV 원본을 NAS에 저장 (csv_path 없는 항목 → 기존 항목 백필 가능)
 *   - json=1: CSV를 Flask로 변환한 JSON을 NAS에 저장 (nas_path 없는 항목)
 */
export async function POST(req: NextRequest) {
  if (!NOTION_API_KEY) {
    return NextResponse.json({ error: "NOTION_API_KEY 환경변수가 설정되지 않았습니다." }, { status: 500 });
  }
  if (isSyncRunning()) {
    return NextResponse.json({ started: false, job: getSyncJob() }, { status: 409 });
  }

  const sp = req.nextUrl.searchParams;
  const wantCsv = sp.get("csv") !== "0"; // 기본 true
  const wantJson = sp.get("json") !== "0"; // 기본 true
  const force = sp.get("force") === "1"; // 이미 업로드된 항목도 재업로드 (NAS 유실 복구용)

  const actor = (await getActor(req)) ?? "system"; // 수동 실행=사용자, 스케줄러=쿠키 없음→system
  beginSyncJob({ csv: wantCsv, json: wantJson });
  void runSyncJob(wantCsv, wantJson, force, actor); // fire-and-forget (장기 서버 프로세스라 요청 종료 후에도 계속)
  return NextResponse.json({ started: true, job: getSyncJob() }, { status: 202 });
}

/** 실제 동기화 루프 — 백그라운드 실행, 진행 상황을 prompt-sync-job 상태에 기록. */
async function runSyncJob(wantCsv: boolean, wantJson: boolean, force: boolean, actor: string): Promise<void> {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, sorts: [{ property: "VMS 적용 일자", direction: "descending" }] }),
      cache: "no-store",
    });
    if (!res.ok) { finishSyncJob({ error: `Notion API 오류: ${await res.text()}` }); return; }

    const data = await res.json() as { results: Record<string, unknown>[] };
    const existing    = await listPrompts();
    const existingSet = new Set(existing.map(r => `${r.project_name}||${r.version}`));
    const hasNasSet   = new Set(existing.filter(r => r.nas_path).map(r => `${r.project_name}||${r.version}`));
    const hasCsvSet   = new Set(existing.filter(r => r.csv_path).map(r => `${r.project_name}||${r.version}`));

    const total = data.results.length;
    let inserted = 0, updated = 0, uploaded = 0, skipped = 0, index = 0;
    const counts = () => ({ inserted, updated, uploaded, skipped });
    patchSyncJob({ total });

    for (const page of data.results) {
      index++;
      const props = page.properties as Record<string, Record<string, unknown>>;
      const version     = ((props["버전명"]?.title     ?? []) as { plain_text: string }[]).map(r => r.plain_text).join("").trim();
      const projectName = ((props["프로젝트명"]?.select  ?? null) as { name: string } | null)?.name ?? "";
      const assignees   = ((props["담당자"]?.people     ?? []) as { name?: string }[]).map(p => p.name ?? "").filter(Boolean).join(", ");
      const appliedAt   = ((props["VMS 적용 일자"]?.date ?? null) as { start: string } | null)?.start ?? null;
      const basePrompt  = ((props["Base Prompt"]?.rich_text ?? []) as { plain_text: string }[]).map(r => r.plain_text).join("").trim();
      const hfUrl       = (props["Huggingface URL"]?.url as string | null) ?? null;

      patchSyncJob({ index, version: version || "(무명)", counts: counts() });

      if (!version || !projectName) { pushSyncResult({ version: version || "(무명)", action: "skip" }); continue; }

      const key = `${projectName}||${version}`;
      const record = await insertPrompt({
        project_name: projectName, version, assignees, applied_at: appliedAt,
        nas_path: null, csv_path: null, base_prompt: basePrompt || null,
      });
      existingSet.has(key) ? updated++ : inserted++;

      const needCsv  = wantCsv  && !!hfUrl && (force || !hasCsvSet.has(key));
      const needJson = wantJson && !!hfUrl && (force || !hasNasSet.has(key));
      if (!needCsv && !needJson) { skipped++; pushSyncResult({ version, action: "skip" }); patchSyncJob({ counts: counts() }); continue; }

      const safeVersion = version.replace(/[/\\:*?"<>|]/g, "_");
      const dir      = `${NAS_BASE()}/${safeVersion}`;
      const csvPath  = `${dir}/text_features_${safeVersion}.csv`;
      const jsonPath = `${dir}/text_features_${safeVersion}.json`;

      const csvBuf = await downloadHfCsv(hfUrl!, safeVersion);
      if (!csvBuf) { skipped++; pushSyncResult({ version, action: "failed", reason: "CSV 다운로드 실패" }); patchSyncJob({ counts: counts() }); continue; }

      const done: string[] = [];
      try {
        if (needCsv) {
          await uploadBufToNas(csvBuf, csvPath);
          await updatePromptCsvPath(record.id, csvPath);
          done.push("CSV");
        }
        if (needJson) {
          const jsonStream = await convertViaFlask(csvBuf, safeVersion);
          if (jsonStream) {
            await uploadWebStreamToNas(jsonStream, jsonPath); // 메모리 버퍼링 없이 NAS로 스트리밍
            await updatePromptNasPath(record.id, jsonPath);
            done.push("JSON");
          }
        }
        if (done.length) { uploaded++; pushSyncResult({ version, action: "done", detail: done.join("+") }); }
        else { skipped++; pushSyncResult({ version, action: "failed", reason: "변환 실패" }); }
      } catch (e) {
        skipped++;
        pushSyncResult({ version, action: "failed", reason: e instanceof Error ? e.message : String(e) });
      }
      patchSyncJob({ counts: counts() });
    }

    finishSyncJob({ counts: counts() });
  } catch (e) {
    console.error("[prompt-records] sync error:", e);
    finishSyncJob({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    const job = getSyncJob();
    const c = job.counts;
    await logAudit({
      actor,
      action: "sync",
      target_type: "prompt",
      target_label: "Notion 동기화",
      status: job.error ? "failure" : "success",
      detail: job.error
        ? job.error
        : `업로드 ${c.uploaded} · 스킵 ${c.skipped} · 신규 ${c.inserted} · 수정 ${c.updated} (csv=${wantCsv}, json=${wantJson})`,
    });
  }
}
