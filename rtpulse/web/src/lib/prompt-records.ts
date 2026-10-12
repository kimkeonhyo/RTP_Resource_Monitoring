import { getPool, initDb } from "./db";

export interface PromptRecord {
  id: number;
  project_name: string;
  version: string;
  assignees: string;       // comma-separated names
  applied_at: string | null;
  nas_path: string | null;  // null or '' = JSON 파일 미업로드
  csv_path: string | null;  // null or '' = CSV 파일 미업로드
  base_prompt: string | null;
  registered_at: string;
}

export async function listPrompts(): Promise<PromptRecord[]> {
  await initDb();
  const { rows } = await getPool().query<PromptRecord>(
    `SELECT * FROM prompts ORDER BY applied_at DESC NULLS LAST, registered_at DESC`
  );
  return rows;
}

export async function insertPrompt(data: {
  project_name: string;
  version: string;
  assignees: string;
  applied_at: string | null;
  nas_path: string | null;
  csv_path?: string | null;
  base_prompt: string | null;
}): Promise<PromptRecord> {
  await initDb();
  const now = new Date().toISOString();
  const { rows } = await getPool().query<PromptRecord>(
    `INSERT INTO prompts (project_name, version, assignees, applied_at, nas_path, csv_path, base_prompt, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (project_name, version) DO UPDATE
       SET assignees     = EXCLUDED.assignees,
           applied_at    = EXCLUDED.applied_at,
           nas_path      = COALESCE(EXCLUDED.nas_path, prompts.nas_path),
           csv_path      = COALESCE(EXCLUDED.csv_path, prompts.csv_path),
           base_prompt   = EXCLUDED.base_prompt,
           registered_at = EXCLUDED.registered_at
     RETURNING *`,
    [
      data.project_name,
      data.version,
      data.assignees,
      data.applied_at,
      data.nas_path,
      data.csv_path ?? null,
      data.base_prompt,
      now,
    ]
  );
  return rows[0];
}

export async function updatePromptNasPath(id: number, nasPath: string): Promise<void> {
  await initDb();
  await getPool().query(
    `UPDATE prompts SET nas_path = $1 WHERE id = $2`,
    [nasPath, id]
  );
}

export async function updatePromptCsvPath(id: number, csvPath: string): Promise<void> {
  await initDb();
  await getPool().query(
    `UPDATE prompts SET csv_path = $1 WHERE id = $2`,
    [csvPath, id]
  );
}

/** nas_path 또는 csv_path 를 NULL 로 초기화 (잘못 업로드된 파일 연결 해제) */
export async function clearPromptFilePath(
  id: number,
  field: "nas_path" | "csv_path"
): Promise<void> {
  await initDb();
  await getPool().query(
    `UPDATE prompts SET ${field} = NULL WHERE id = $1`,
    [id]
  );
}

export async function deletePrompt(id: number): Promise<void> {
  await initDb();
  await getPool().query(`DELETE FROM prompts WHERE id = $1`, [id]);
}
