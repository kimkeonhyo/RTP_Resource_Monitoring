/**
 * IMS(ims) DB 읽기 전용 풀.
 *
 * watch와 동일한 Cloud SQL(PostgreSQL) 인스턴스의 `ims` 데이터베이스를 조회한다.
 * 기본적으로 watch의 PG 접속정보를 재사용하되 database만 ims으로 바꾼다.
 * (watch DB 유저가 ims에 SELECT 권한이 있어야 함 — 없으면 IMS_DB_* 로 별도 지정)
 *
 * 읽기 전용으로만 사용한다 (납품현황 조회).
 */
import { Pool } from "pg";

let _pool: Pool | null = null;

export function getImsPool(): Pool {
  if (_pool) return _pool;

  _pool = new Pool({
    host:     process.env.IMS_DB_HOST     ?? process.env.DB_HOST     ?? process.env.PGHOST     ?? "localhost",
    port:     Number(process.env.IMS_DB_PORT ?? process.env.DB_PORT  ?? process.env.PGPORT     ?? 5432),
    database: process.env.IMS_DB_NAME     ?? "ims",
    user:     process.env.IMS_DB_USER     ?? process.env.DB_USER     ?? process.env.PGUSER     ?? "rtpulse",
    password: process.env.IMS_DB_PASSWORD ?? process.env.DB_PASSWORD ?? process.env.PGPASSWORD ?? "",
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: false,
  });

  _pool.on("error", (err) => {
    console.error("[ims-db] Pool idle client error:", err.message);
  });

  return _pool;
}
