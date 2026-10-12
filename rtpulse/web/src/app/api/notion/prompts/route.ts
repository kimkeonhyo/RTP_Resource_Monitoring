import { NextRequest, NextResponse } from "next/server";

const NOTION_API_KEY = process.env.NOTION_API_KEY ?? "";
const NOTION_DB_ID   = process.env.NOTION_PROMPT_DB_ID ?? "";

export interface NotionPromptRow {
  id: string;
  version: string;       // 버전명 (title)
  projectName: string;   // 프로젝트명 (select)
  assignees: string[];   // 담당자 (people)
  appliedAt: string | null; // VMS 적용 일자 (date)
  basePrompt: string;    // Base Prompt (rich_text)
  huggingfaceUrl: string | null; // Huggingface URL (url)
  notionUrl: string;     // Notion 페이지 링크
}

function extractText(prop: Record<string, unknown>): string {
  const type = prop.type as string;
  if (type === "title")     return (prop.title as {plain_text:string}[]).map(r => r.plain_text).join("") || "";
  if (type === "rich_text") return (prop.rich_text as {plain_text:string}[]).map(r => r.plain_text).join("") || "";
  if (type === "select")    return (prop.select as {name:string} | null)?.name ?? "";
  if (type === "url")       return (prop.url as string | null) ?? "";
  if (type === "date")      return (prop.date as {start:string} | null)?.start ?? "";
  if (type === "people")    return (prop.people as {name?:string}[]).map(p => p.name ?? "").join(", ");
  return "";
}

function parseRow(page: Record<string, unknown>): NotionPromptRow {
  const props = page.properties as Record<string, Record<string, unknown>>;
  return {
    id: page.id as string,
    version: extractText(props["버전명"] ?? {}),
    projectName: extractText(props["프로젝트명"] ?? {}),
    assignees: ((props["담당자"]?.people ?? []) as {name?:string}[]).map(p => p.name ?? ""),
    appliedAt: (props["VMS 적용 일자"]?.date as {start:string}|null)?.start ?? null,
    basePrompt: extractText(props["Base Prompt"] ?? {}),
    huggingfaceUrl: (props["Huggingface URL"]?.url as string|null) ?? null,
    notionUrl: `https://notion.so/${(page.id as string).replace(/-/g, "")}`,
  };
}

/**
 * GET /api/notion/prompts?projectName=xxx
 * Notion Prompt 배포 이력 DB를 조회합니다.
 * projectName이 주어지면 해당 프로젝트명으로 필터링합니다.
 */
export async function GET(req: NextRequest) {
  if (!NOTION_API_KEY) {
    return NextResponse.json({ error: "NOTION_API_KEY 환경변수가 설정되지 않았습니다." }, { status: 500 });
  }

  const projectName = req.nextUrl.searchParams.get("projectName") ?? "";

  const body: Record<string, unknown> = {
    page_size: 100,
    sorts: [{ property: "VMS 적용 일자", direction: "descending" }],
  };

  if (projectName) {
    body.filter = {
      property: "프로젝트명",
      select: { equals: projectName },
    };
  }

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `Notion API 오류: ${err}` }, { status: res.status });
    }

    const data = await res.json() as { results: Record<string, unknown>[] };
    const rows = data.results.map(parseRow);
    return NextResponse.json({ rows, total: rows.length });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
