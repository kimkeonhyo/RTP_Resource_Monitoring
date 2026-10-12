import mysql from "mysql2/promise";

export interface VmsDbConn {
  host:     string;
  port:     string | number;
  user:     string;
  password: string;
  dbName:   string;
}

/**
 * 요청마다 새 커넥션을 열고, 작업 후 반드시 닫는다.
 * VMS DB는 고객사마다 접속 정보가 달라서 풀을 쓰지 않는다.
 */
export async function withVmsDb<T>(
  conn: VmsDbConn,
  fn: (db: mysql.Connection) => Promise<T>
): Promise<T> {
  const db = await mysql.createConnection({
    host:     conn.host,
    port:     Number(conn.port),
    user:     conn.user,
    password: conn.password,
    database: conn.dbName,
    connectTimeout: 5_000,
  });
  try {
    return await fn(db);
  } finally {
    await db.end().catch(() => {});
  }
}
