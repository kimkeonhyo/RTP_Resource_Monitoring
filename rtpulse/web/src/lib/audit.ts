/**
 * 감사 로그 — 누가(actor) 무엇을(action/target) 했고 성공/실패했는지 기록/조회.
 * 기록은 best-effort(실패해도 원래 작업을 막지 않음).
 */
import { getPool, initDb } from "@/lib/db";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";

export type AuditStatus = "success" | "failure";

export interface AuditEntry {
  actor: string;
  action: string;        // create / update / delete / sync ...
  target_type: string;   // customer / prompt / complaint ...
  target_id?: string | null;
  target_label?: string | null;
  status?: AuditStatus;  // 기본 success
  detail?: string | null;
}

export interface AuditRow extends AuditEntry {
  id: number;
  created_at: string;
  status: AuditStatus;
}

/** API 라우트 요청에서 로그인 사용자 이메일을 추출(없으면 null). */
export async function getActor(req: NextRequest): Promise<string | null> {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    return (token?.email as string | undefined) ?? (token?.name as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** 감사 로그 1건 기록 (실패는 로깅만, throw 안 함). */
export async function logAudit(e: AuditEntry): Promise<void> {
  try {
    await initDb();
    await getPool().query(
      `INSERT INTO audit_logs (created_at, actor, action, target_type, target_id, target_label, status, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        new Date().toISOString(),
        e.actor || "unknown",
        e.action,
        e.target_type ?? "",
        e.target_id ?? null,
        e.target_label ?? null,
        e.status ?? "success",
        e.detail ?? null,
      ],
    );
  } catch (err) {
    console.error("[audit] 기록 실패:", err instanceof Error ? err.message : String(err));
  }
}

export async function listAudit(opts: {
  limit?: number; offset?: number; status?: string; actor?: string; targetType?: string;
} = {}): Promise<{ rows: AuditRow[]; total: number }> {
  await initDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status)     { params.push(opts.status);       where.push(`status = $${params.length}`); }
  if (opts.actor)      { params.push(`%${opts.actor}%`);  where.push(`actor ILIKE $${params.length}`); }
  if (opts.targetType) { params.push(opts.targetType);    where.push(`target_type = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await getPool().query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM audit_logs ${whereSql}`, params);
  const rowsRes = await getPool().query<AuditRow>(
    `SELECT id, created_at, actor, action, target_type, target_id, target_label, status, detail
       FROM audit_logs ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { rows: rowsRes.rows, total: Number(totalRes.rows[0]?.count ?? 0) };
}
