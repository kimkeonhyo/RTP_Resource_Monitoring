import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";
import { notifyNewComplaint } from "@/lib/teams-notify";
import { isValidCategory, getCategory, DEFAULT_PRIORITY } from "@/lib/complain-categories";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await initDb();
  const pool = getPool();

  // ?category=complain|business|inquiry 로 필터. 미지정 시 전체 반환.
  const category = req.nextUrl.searchParams.get("category");
  const where = isValidCategory(category) ? `WHERE c.category = $1` : ``;
  const params = isValidCategory(category) ? [category] : [];

  const { rows } = await pool.query(`
    SELECT
      c.*,
      COALESCE(f.file_count, 0)::int AS file_count
    FROM complaints c
    LEFT JOIN (
      SELECT complaint_id, COUNT(*) AS file_count
      FROM complaint_files
      GROUP BY complaint_id
    ) f ON f.complaint_id = c.id
    ${where}
    ORDER BY c.id DESC
  `, params);
  return NextResponse.json({ complaints: rows });
}

export async function POST(req: NextRequest) {
  await initDb();
  const pool = getPool();
  const body = await req.json() as {
    title?: string;
    customer_name?: string;
    applicant_name?: string;
    job_title?: string;
    email?: string;
    phone?: string;
    reporter?: string;
    assignee?: string;
    status?: string;
    received_at?: string;
    phenomenon?: string;
    action_method?: string;
    action_result?: string;
    category?: string;
    priority?: string;
  };

  const cat = getCategory(body.category);

  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO complaints
       (title, customer_name, applicant_name, job_title, email, phone, reporter, assignee, status, received_at,
        phenomenon, action_method, action_result, category, priority, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
     RETURNING *`,
    [
      body.title ?? "",
      body.customer_name ?? "",
      body.applicant_name ?? "",
      body.job_title ?? "",
      body.email ?? "",
      body.phone ?? "",
      body.reporter ?? "",
      body.assignee ?? "",
      body.status ?? cat.defaultStatus,
      body.received_at ?? "",
      body.phenomenon ?? "",
      body.action_method ?? "",
      body.action_result ?? "",
      cat.key,
      body.priority || DEFAULT_PRIORITY,
      now,
    ]
  );
  const complaint = rows[0];

  // Teams 채널 알림 (비동기, 실패해도 응답에 영향 없음)
  notifyNewComplaint(complaint).catch(() => {});

  return NextResponse.json({ complaint }, { status: 201 });
}
