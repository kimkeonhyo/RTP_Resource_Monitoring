import { NextRequest, NextResponse } from "next/server";
import { getPool, initDb } from "@/lib/db";
import { notifyNewComplaint } from "@/lib/teams-notify";
import { getCategory, isValidCategory } from "@/lib/complain-categories";

export const runtime = "nodejs";

/**
 * 외부 시스템(Chatwoot ↔ Dify 웹훅)에서 HELPDESK 카드를 자동 생성하는 인제스트 엔드포인트.
 *
 * 인증: 공유 토큰 (헤더 x-webhook-token === env HELPDESK_INGEST_TOKEN).
 *       proxy.ts(미들웨어)의 matcher에서 제외되어 next-auth 세션 없이 접근 가능.
 *
 * 중복 방지: external_id (예: "chatwoot:42") 유니크 인덱스.
 *           같은 대화에서 메시지가 여러 번 와도 카드는 1개만 생성된다.
 */
export async function POST(req: NextRequest) {
  // ── 토큰 인증 ──────────────────────────────────────────────────────────────
  const expected = process.env.HELPDESK_INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "ingest disabled (no token configured)" }, { status: 503 });
  }
  const token = req.headers.get("x-webhook-token");
  if (token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await initDb();
  const pool = getPool();

  const body = await req.json() as {
    category?: string;
    title?: string;
    customer_name?: string;
    applicant_name?: string;
    email?: string;
    phone?: string;
    job_title?: string;
    reporter?: string;
    assignee?: string;
    status?: string;
    received_at?: string;
    external_id?: string;
    source?: string;
    set_stage?: "in_progress" | "done";
  };

  // ── category 검증: 값이 주어졌는데 알 수 없는 키면 400 (DB로 잘못된 값 유입 방지) ──
  if (body.category != null && !isValidCategory(body.category)) {
    return NextResponse.json(
      { error: `invalid category: ${body.category}` },
      { status: 400 }
    );
  }

  const cat = getCategory(body.category);
  const externalId = body.external_id?.trim() || null;

  // ── 중복 체크 / 상태 자동전이: 동일 external_id 카드가 이미 있으면 ──────────
  if (externalId) {
    const { rows } = await pool.query(
      `SELECT * FROM complaints WHERE external_id = $1 LIMIT 1`,
      [externalId]
    );
    if (rows.length > 0) {
      const existing = rows[0];
      // set_stage가 오면 카드 카테고리에 맞는 상태로 전이 (전진만, 수동 단계/종료 상태는 보존)
      if (body.set_stage) {
        const ecat = getCategory(existing.category);
        const target = body.set_stage === "done" ? ecat.doneStatus : ecat.inProgressStatus;
        const cur = existing.status as string;
        // 보호: 중지/보류이거나 이미 완료 상태면 자동전이하지 않음.
        //       in_progress는 "접수"에서만 전진(담당자가 수동으로 진행한 단계를 되돌리지 않음).
        const terminal = ["중지", "보류", ...ecat.doneStatuses];
        const allow =
          !terminal.includes(cur) &&
          (body.set_stage === "done" || cur === ecat.defaultStatus) &&
          cur !== target;
        if (allow) {
          const { rows: up } = await pool.query(
            `UPDATE complaints
               SET status = $1,
                   resolved_at = CASE WHEN $2 = 'done' AND (resolved_at IS NULL OR resolved_at = '')
                                      THEN $3 ELSE resolved_at END,
                   updated_at = $4
             WHERE external_id = $5 RETURNING *`,
            [target, body.set_stage, new Date().toISOString().slice(0, 10), new Date().toISOString(), externalId]
          );
          return NextResponse.json({ complaint: up[0], updated: true, stage: body.set_stage }, { status: 200 });
        }
      }

      // 인테이크 정보(신청자/이메일/연락처/고객사)가 제공되면 기존 카드에 채운다.
      // 대화형 인테이크(봇이 추가로 수집한 값)를 반영. 제공된 비어있지 않은 값만 덮어쓴다.
      const intakeMap: Record<string, string | undefined> = {
        applicant_name: body.applicant_name,
        email: body.email,
        phone: body.phone,
        customer_name: body.customer_name,
        job_title: body.job_title,
      };
      const sets: string[] = [];
      const vals: string[] = [];
      let i = 1;
      for (const [col, v] of Object.entries(intakeMap)) {
        if (typeof v === "string" && v.trim() !== "") {
          sets.push(`${col} = $${i++}`);
          vals.push(v.trim());
        }
      }
      if (sets.length > 0) {
        vals.push(new Date().toISOString());          // updated_at
        vals.push(externalId);                          // where
        const { rows: up } = await pool.query(
          `UPDATE complaints SET ${sets.join(", ")}, updated_at = $${i++} WHERE external_id = $${i} RETURNING *`,
          vals
        );
        return NextResponse.json({ complaint: up[0], updated: true, fields: sets.length }, { status: 200 });
      }

      return NextResponse.json({ complaint: existing, deduped: true }, { status: 200 });
    }
    // 카드가 없는데 set_stage만 온 경우(아직 ingest 전): 생성하지 않고 무시.
    if (body.set_stage) {
      return NextResponse.json({ skipped: "no card for external_id" }, { status: 200 });
    }
  }

  const now = new Date().toISOString();
  const receivedAt = body.received_at || now.slice(0, 10);

  let complaint;
  try {
    const { rows } = await pool.query(
      `INSERT INTO complaints
         (title, customer_name, applicant_name, email, phone, job_title, reporter, assignee, status, received_at,
          phenomenon, action_method, action_result, category, source, external_id,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'','','',$11,$12,$13,$14,$14)
       RETURNING *`,
      [
        body.title ?? "",
        body.customer_name ?? "",
        body.applicant_name ?? "",
        body.email ?? "",
        body.phone ?? "",
        body.job_title ?? "",
        body.reporter ?? "",
        body.assignee ?? "",
        body.status ?? cat.defaultStatus,
        receivedAt,
        cat.key,
        body.source ?? "chatwoot",
        externalId,
        now,
      ]
    );
    complaint = rows[0];
  } catch (e: unknown) {
    // 유니크 위반(동시 요청 레이스) → 기존 카드 반환
    const code = (e as { code?: string })?.code;
    if (code === "23505" && externalId) {
      const { rows } = await pool.query(
        `SELECT * FROM complaints WHERE external_id = $1 LIMIT 1`,
        [externalId]
      );
      if (rows.length > 0) {
        return NextResponse.json({ complaint: rows[0], deduped: true }, { status: 200 });
      }
    }
    throw e;
  }

  // Teams 알림 (비동기, 실패 무시)
  notifyNewComplaint(complaint).catch(() => {});

  return NextResponse.json({ complaint, deduped: false }, { status: 201 });
}
