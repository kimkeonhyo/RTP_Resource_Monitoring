import { getPool, initDb } from "./db";
import type { PromptRecord } from "./types";

export interface PromptRow extends PromptRecord {
  id: number;
  customerId: string;
}

type Row = Record<string, unknown>;

function rowToPrompt(r: Row): PromptRow {
  return {
    id:             r.id as number,
    customerId:     r.customer_id as string,
    notionId:       r.notion_id as string,
    version:        (r.version as string)         ?? "",
    basePrompt:     (r.base_prompt as string)     ?? "",
    assignees:      (r.assignees as string[])     ?? [],
    appliedAt:      (r.applied_at as string)      ?? null,
    huggingfaceUrl: (r.huggingface_url as string) ?? null,
    notionUrl:      r.notion_url as string,
    registeredAt:   r.registered_at as string,
    isActive:       (r.is_active as boolean)      ?? false,
  };
}

async function db() {
  await initDb();
  return getPool();
}

export async function getPromptHistory(customerId: string): Promise<PromptRow[]> {
  const pool = await db();
  const { rows } = await pool.query(
    "SELECT * FROM prompt_history WHERE customer_id = $1 ORDER BY registered_at DESC",
    [customerId]
  );
  return rows.map(rowToPrompt);
}

export async function addPromptRecord(
  customerId: string,
  record: Omit<PromptRecord, "registeredAt" | "isActive">
): Promise<{ row?: PromptRow; error?: string }> {
  const pool = await db();

  // 버전명 중복 체크
  if (record.version) {
    const { rows: existing } = await pool.query(
      "SELECT id FROM prompt_history WHERE customer_id = $1 AND version = $2",
      [customerId, record.version]
    );
    if (existing.length > 0) {
      return { error: `버전명 "${record.version}"이 이미 등록되어 있습니다.` };
    }
  }

  const registeredAt = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO prompt_history
       (customer_id, notion_id, version, base_prompt, assignees,
        applied_at, huggingface_url, notion_url, registered_at, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)
     RETURNING *`,
    [
      customerId,
      record.notionId,
      record.version    ?? null,
      record.basePrompt ?? null,
      JSON.stringify(record.assignees ?? []),
      record.appliedAt      ?? null,
      record.huggingfaceUrl ?? null,
      record.notionUrl,
      registeredAt,
    ]
  );
  return { row: rowToPrompt(rows[0]) };
}

export async function deletePromptRecord(customerId: string, id: number): Promise<boolean> {
  const pool = await db();
  const { rowCount } = await pool.query(
    "DELETE FROM prompt_history WHERE id = $1 AND customer_id = $2",
    [id, customerId]
  );
  return (rowCount ?? 0) > 0;
}

/** 해당 id를 사용 중으로 설정하고 나머지는 해제 */
export async function setActivePrompt(customerId: string, id: number): Promise<boolean> {
  const pool = await db();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE prompt_history SET is_active = FALSE WHERE customer_id = $1",
      [customerId]
    );
    const { rowCount } = await client.query(
      "UPDATE prompt_history SET is_active = TRUE WHERE id = $1 AND customer_id = $2",
      [id, customerId]
    );
    await client.query("COMMIT");
    return (rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** 사용 해제 (is_active → false) */
export async function unsetActivePrompt(customerId: string, id: number): Promise<void> {
  const pool = await db();
  await pool.query(
    "UPDATE prompt_history SET is_active = FALSE WHERE id = $1 AND customer_id = $2",
    [id, customerId]
  );
}
