import { getPool, initDb } from "./db";
import { Customer, NetworkType } from "./types";
import { randomUUID } from "crypto";

type Row = Record<string, unknown>;

function rowToCustomer(r: Row): Customer {
  return {
    id:           r.id as string,
    name:         r.name as string,
    networkType:  ((r.network_type as string) ?? "remote") as NetworkType,
    apiUrl:       r.api_url as string,
    ip:           (r.ip as string)           ?? undefined,
    rtpulsePort:  (r.rtpulse_port as number) ?? undefined,
    timezone:     (r.timezone as string)     ?? "Asia/Seoul",
    description:  (r.description as string)  ?? undefined,
    slackWebhook: (r.slack_webhook as string)?? undefined,
    // vip: 우선 vip 컬럼, 없으면 기존 db_ip 컬럼 fallback
    vip:          ((r.vip as string) ?? (r.db_ip as string)) ?? undefined,
    dbName:       (r.db_name as string)      ?? undefined,
    dbPort:       (r.db_port as number)      ?? undefined,
    dbUser:       (r.db_user as string)      ?? undefined,
    dbPassword:   (r.db_password as string)  ?? undefined,
    sshUser:      (r.ssh_user as string)     ?? undefined,
    sshPassword:  (r.ssh_password as string) ?? undefined,
    nasPath:      (r.nas_path as string)     ?? undefined,
    metricsLabel: (r.metrics_label as string)?? undefined,
    createdAt:    r.created_at as string,
  };
}

async function db() {
  await initDb();
  return getPool();
}

export async function getCustomers(): Promise<Customer[]> {
  const pool = await db();
  const { rows } = await pool.query("SELECT * FROM customers ORDER BY created_at DESC");
  return rows.map(rowToCustomer);
}

export async function getCustomer(id: string): Promise<Customer | undefined> {
  const pool = await db();
  const { rows } = await pool.query("SELECT * FROM customers WHERE id = $1", [id]);
  return rows[0] ? rowToCustomer(rows[0]) : undefined;
}

export async function createCustomer(data: Omit<Customer, "id" | "createdAt">): Promise<Customer> {
  const pool = await db();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO customers
       (id, name, network_type, api_url, ip, rtpulse_port, timezone, description, slack_webhook,
        vip, db_ip, db_name, db_port, db_user, db_password,
        ssh_user, ssh_password, nas_path, metrics_label, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      id, data.name, data.networkType ?? "remote", data.apiUrl, data.ip ?? null,
      data.rtpulsePort ?? null, data.timezone ?? "Asia/Seoul",
      data.description ?? null, data.slackWebhook ?? null,
      data.vip ?? null, // $10: vip (db_ip 도 같은 값으로 채워서 기존 코드 호환)
      data.dbName ?? null, data.dbPort ?? null,
      data.dbUser ?? null, data.dbPassword ?? null,
      data.sshUser ?? null, data.sshPassword ?? null, data.nasPath ?? null,
      data.metricsLabel ?? null,
      createdAt,
    ]
  );
  return { ...data, id, createdAt };
}

export async function updateCustomer(
  id: string,
  data: Partial<Omit<Customer, "id" | "createdAt">>
): Promise<Customer | null> {
  const pool = await db();
  const existing = await getCustomer(id);
  if (!existing) return null;

  const m = { ...existing, ...data }; // merge
  await pool.query(
    `UPDATE customers SET
       name=$1, network_type=$2, api_url=$3, ip=$4, rtpulse_port=$5, timezone=$6,
       description=$7, slack_webhook=$8, vip=$9, db_ip=$9, db_name=$10, db_port=$11,
       db_user=$12, db_password=$13, ssh_user=$14, ssh_password=$15, nas_path=$16,
       metrics_label=$17
     WHERE id=$18`,
    [
      m.name, m.networkType ?? "remote", m.apiUrl, m.ip ?? null, m.rtpulsePort ?? null,
      m.timezone ?? "Asia/Seoul",
      m.description ?? null, m.slackWebhook ?? null,
      m.vip ?? null, // $9: vip 와 db_ip 동시에 업데이트
      m.dbName ?? null, m.dbPort ?? null,
      m.dbUser ?? null, m.dbPassword ?? null,
      m.sshUser ?? null, m.sshPassword ?? null, m.nasPath ?? null,
      m.metricsLabel ?? null,
      id,
    ]
  );
  return getCustomer(id) as Promise<Customer>;
}

export async function deleteCustomer(id: string): Promise<boolean> {
  const pool = await db();
  const { rowCount } = await pool.query("DELETE FROM customers WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
