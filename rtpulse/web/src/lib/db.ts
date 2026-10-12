import { Pool } from "pg";

let _pool: Pool | null = null;

// initDb()는 프로세스당 딱 한 번만 실행 (동시 호출 시 같은 Promise 반환)
let _initPromise: Promise<void> | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;

  _pool = new Pool({
    host:     process.env.DB_HOST     ?? process.env.PGHOST     ?? "localhost",
    port:     Number(process.env.DB_PORT     ?? process.env.PGPORT     ?? 5432),
    database: process.env.DB_NAME     ?? process.env.PGDATABASE ?? "rtpulse",
    user:     process.env.DB_USER     ?? process.env.PGUSER     ?? "rtpulse",
    password: process.env.DB_PASSWORD ?? process.env.PGPASSWORD ?? "",
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: false,
  });

  // Pool idle client 에러 핸들러 — 미등록 시 unhandled EventEmitter error →
  // Node.js 프로세스 크래시. DB 연결이 서버 측에서 끊어질 때 발생.
  _pool.on("error", (err) => {
    console.error("[db] Pool idle client error:", err.message);
  });

  return _pool;
}

/** 최초 실행 시 테이블 생성 + customers.json 마이그레이션
 *  동시 호출해도 DDL이 한 번만 실행되도록 singleton promise 사용 */
export function initDb(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = _runInit().catch((e) => {
    _initPromise = null; // 실패 시 재시도 가능하도록 초기화
    throw e;
  });
  return _initPromise;
}

async function _runInit() {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      api_url       TEXT NOT NULL,
      ip            TEXT,
      rtpulse_port  INTEGER,
      description   TEXT,
      slack_webhook TEXT,
      db_ip         TEXT,
      db_name       TEXT,
      db_port       INTEGER,
      db_user       TEXT,
      db_password   TEXT,
      ssh_user      TEXT,
      ssh_password  TEXT,
      nas_path      TEXT,
      created_at    TEXT NOT NULL
    );

    -- 마이그레이션: vip 컬럼 추가 (db_ip 대체), network_type 컬럼 추가
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS vip          TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS network_type TEXT NOT NULL DEFAULT 'remote';
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS timezone     TEXT NOT NULL DEFAULT 'Asia/Seoul';

    -- 중앙 메트릭 연결: 고객사 Prometheus external_labels.customer 값
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS metrics_label TEXT;

    -- 기존 db_ip 데이터를 vip 로 복사 (한 번만)
    UPDATE customers SET vip = db_ip WHERE vip IS NULL AND db_ip IS NOT NULL;

    CREATE TABLE IF NOT EXISTS prompt_history (
      id             SERIAL PRIMARY KEY,
      customer_id    TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      notion_id      TEXT NOT NULL,
      version        TEXT,
      base_prompt    TEXT,
      assignees      JSONB NOT NULL DEFAULT '[]',
      applied_at     TEXT,
      huggingface_url TEXT,
      notion_url     TEXT NOT NULL,
      registered_at  TEXT NOT NULL,
      is_active      BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_history_customer
      ON prompt_history(customer_id);

    -- 기존 테이블에 is_active 컬럼 추가 (마이그레이션)
    ALTER TABLE prompt_history ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT FALSE;

    -- NAS 업로드 탐지 결과 (TP/FP) 저장
    CREATE TABLE IF NOT EXISTS detection_results (
      id            SERIAL PRIMARY KEY,
      customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      customer_name TEXT NOT NULL DEFAULT '',
      file_name     TEXT NOT NULL,
      result        TEXT,
      updated_at    TEXT NOT NULL,
      UNIQUE(customer_id, file_name)
    );

    -- 기존 테이블에 customer_name 컬럼 추가 (마이그레이션)
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS customer_name TEXT NOT NULL DEFAULT '';

    -- 오토라벨링 컬럼 추가 (마이그레이션)
    -- auto_labeled=TRUE: Gemini가 판단, FALSE(기본): 사람이 직접 라벨링
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS auto_labeled      BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS auto_label_reason TEXT;

    -- 탐지결과 메타데이터 컬럼 추가 (원격 고객사 통계 지원)
    -- 원격: file_name = MySQL _id (숫자) → 이 컬럼으로 이벤트명/카메라/시간 보관
    -- NAS : file_name = base_name       → 백필 UPDATE로 채워짐
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS event_name TEXT;
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS camera_id  TEXT;
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS event_time TEXT;

    -- 상세 라벨명 (falldown·smoke·fire·esfalldown 이벤트 오토라벨링용)
    -- TP: event_name 그대로 / FP: 실제 상황(normal·falldown·smoke·fire·esfalldown)
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS label_name TEXT;

    -- NAS 업로드 파일 목록 (서비스 재시작 후에도 지속 보관)
    CREATE TABLE IF NOT EXISTS nas_uploads (
      id          SERIAL PRIMARY KEY,
      customer_id TEXT    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      file_name   TEXT    NOT NULL,
      sub_path    TEXT    NOT NULL DEFAULT '',
      file_type   TEXT    NOT NULL,   -- 'video' | 'thumbnail'
      nas_path    TEXT    NOT NULL,   -- SFTP 풀 경로 (파일 다운로드용)
      size_bytes  INTEGER,
      camera_id   TEXT,
      event_name  TEXT,
      start_time  TEXT,              -- "2026-04-20 05:55:32"
      uploaded_at TEXT    NOT NULL,
      UNIQUE(customer_id, nas_path)
    );

    CREATE INDEX IF NOT EXISTS idx_nas_uploads_customer
      ON nas_uploads(customer_id, sub_path, file_type);

    -- 사용자가 선택해서 등록한 이벤트 목록 (NAS 경로만 저장, VM 리소스 최소화)
    CREATE TABLE IF NOT EXISTS event_registrations (
      id            SERIAL PRIMARY KEY,
      customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      base_name     TEXT NOT NULL,      -- "189_intrusion_20260419_205033"
      camera_id     TEXT,
      event_name    TEXT,
      start_time    TEXT,
      sub_path      TEXT NOT NULL DEFAULT '',
      video_path    TEXT,               -- NAS full path (썸네일/영상은 NAS에서 직접 불러옴)
      thumb_path    TEXT,
      video_file    TEXT,               -- 파일명 (다운로드 시 사용)
      thumb_file    TEXT,
      registered_at TEXT NOT NULL,
      UNIQUE(customer_id, base_name)
    );

    CREATE INDEX IF NOT EXISTS idx_event_registrations_customer
      ON event_registrations(customer_id, sub_path);

    -- 카메라 설정 (DB가 단일 권위 소스 — rtpulse가 이 테이블을 폴링)
    CREATE TABLE IF NOT EXISTS cameras (
      id             TEXT PRIMARY KEY,
      customer_id    TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      name           VARCHAR(255) NOT NULL,
      mainstream_url TEXT NOT NULL,
      substream_url  TEXT,
      location       VARCHAR(255),
      description    TEXT,
      enabled        BOOLEAN NOT NULL DEFAULT true,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cameras_customer
      ON cameras(customer_id);

    -- 글로벌 프롬프트 레코드 (고객사 무관, NAS 기반 JSON 관리)
    CREATE TABLE IF NOT EXISTS prompts (
      id            SERIAL PRIMARY KEY,
      project_name  TEXT NOT NULL,
      version       TEXT NOT NULL,
      assignees     TEXT NOT NULL DEFAULT '',
      applied_at    TEXT,
      nas_path      TEXT,
      base_prompt   TEXT,
      registered_at TEXT NOT NULL,
      UNIQUE(project_name, version)
    );
    -- nas_path가 NOT NULL이었던 이전 버전 마이그레이션
    ALTER TABLE prompts ALTER COLUMN nas_path DROP NOT NULL;
    -- csv_path 컬럼 추가 (이전 버전 마이그레이션)
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS csv_path TEXT;

    -- 사이트 설정 키-값 저장소 (편집 가능한 가이드 내용 등)
    CREATE TABLE IF NOT EXISTS site_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 감사 로그 (누가/무엇을/성공·실패)
    CREATE TABLE IF NOT EXISTS audit_logs (
      id           SERIAL PRIMARY KEY,
      created_at   TEXT NOT NULL,
      actor        TEXT NOT NULL DEFAULT 'unknown',   -- 사용자 이메일 또는 'system'
      action       TEXT NOT NULL,                     -- create/update/delete/sync ...
      target_type  TEXT NOT NULL DEFAULT '',          -- customer/prompt/complaint ...
      target_id    TEXT,
      target_label TEXT,
      status       TEXT NOT NULL DEFAULT 'success',    -- success/failure
      detail       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

    -- 고객 불만(COMPLAIN) 관리
    CREATE TABLE IF NOT EXISTS complaints (
      id            SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      reporter      TEXT NOT NULL DEFAULT '',
      assignee      TEXT NOT NULL DEFAULT '',
      title         TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT '접수',
      received_at   TEXT NOT NULL DEFAULT '',
      resolved_at   TEXT,
      phenomenon    TEXT NOT NULL DEFAULT '',
      action_method TEXT NOT NULL DEFAULT '',
      action_result TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS complaint_files (
      id           SERIAL PRIMARY KEY,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      file_name    TEXT NOT NULL,
      file_type    TEXT NOT NULL,
      file_size    INTEGER,
      uploaded_at  TEXT NOT NULL
    );
  `);

  // complaints.response_status 컬럼 추가 (기존 테이블 대응)
  await pool.query(`
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS response_status TEXT NOT NULL DEFAULT ''
  `);

  // complaints.category 컬럼 추가 (complain | business | inquiry)
  // 기존 데이터는 모두 'complain'으로 유지된다.
  await pool.query(`
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'complain'
  `);

  // 외부 연동(Chatwoot 등) 추적용 컬럼.
  //  - source: 'manual' | 'chatwoot' ...
  //  - external_id: 외부 시스템의 고유 키 (예: 'chatwoot:42') — 중복 카드 생성 방지
  await pool.query(`
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS external_id TEXT;
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS complaints_external_id_uniq
      ON complaints(external_id) WHERE external_id IS NOT NULL
  `);

  // 고객 인테이크 필드 (채팅 접수 시 최초 기록)
  //  - customer_name: 고객사(회사명) [기존]
  //  - applicant_name: 신청자(이름)
  //  - email: 이메일
  //  - phone: 연락처
  //  - job_title: 직책 (신청자 직책)
  await pool.query(`
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS applicant_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS email          TEXT NOT NULL DEFAULT '';
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS phone          TEXT NOT NULL DEFAULT '';
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS job_title      TEXT NOT NULL DEFAULT '';
  `);

  // complaint_files.section 컬럼 추가 (bug | action_result)
  await pool.query(`
    ALTER TABLE complaint_files ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'bug'
  `);

  // complaints.priority 컬럼 추가 (urgent | high | medium | low) — QA 이슈 조치기간 기준
  await pool.query(`
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
  `);

  // 유지보수(정기 점검) — HELPDESK 하위. 납품현황(ims.shipments)을 기준으로
  // 고객사별 점검 일정/결과를 관리하고 다음 점검을 자동 등록한다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_inspections (
      id              SERIAL PRIMARY KEY,
      customer_name   TEXT    NOT NULL,
      shipment_id     TEXT,                          -- ims.shipments 링크(선택)
      inspection_name TEXT    NOT NULL,              -- 초기점검/안정화/월간 점검/반기 점검/연간 점검
      cycle           TEXT,                          -- 2주/1개월/6개월/1년 (다음 일정 계산 기준)
      scheduled_date  DATE    NOT NULL,              -- 점검 예정일 (달력 등록)
      completed_date  DATE,                          -- 점검 완료일
      status          TEXT    NOT NULL DEFAULT '예정', -- 예정/완료/취소
      inspector       TEXT    NOT NULL DEFAULT '',   -- 점검자
      purpose         TEXT    NOT NULL DEFAULT '',   -- 개요-목적
      report          JSONB   NOT NULL DEFAULT '{}', -- 상세 리포트(운영환경/점검내용/결과/후속계획)
      next_id         INTEGER,                        -- 자동 생성된 다음 점검 row id
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_maintenance_customer  ON maintenance_inspections(customer_name);
    CREATE INDEX IF NOT EXISTS idx_maintenance_scheduled ON maintenance_inspections(scheduled_date);
    CREATE INDEX IF NOT EXISTS idx_maintenance_status    ON maintenance_inspections(status);
  `);

  // detection_results APO 관련 컬럼 추가
  await pool.query(`
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS is_watched  BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS is_deleted  BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS thumb_path  TEXT;
    ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS video_path  TEXT;
  `);

  // APO 전용 테이블 — Watch가 APO 백엔드에 제공하는 이벤트 목록
  // 컬럼명은 Excel 명세서(watch apo db 명세서.xlsx) 기준으로 통일
  await pool.query(`
    CREATE TABLE IF NOT EXISTS copy_camera_events (
      id                SERIAL PRIMARY KEY,
      _id               TEXT        NOT NULL,
      customer_id       TEXT        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      customer_name     TEXT        NOT NULL DEFAULT '',
      created_at        TEXT,
      updated_at        TEXT        NOT NULL,
      event_time        TEXT,
      camera_id         TEXT,
      event_name        TEXT,
      type              TEXT,
      dis_connection    BOOLEAN     NOT NULL DEFAULT FALSE,
      thumbnail         TEXT,
      video_url         TEXT,
      is_media_exist    BOOLEAN     NOT NULL DEFAULT FALSE,
      new_event_name    TEXT,
      label_name        TEXT,
      result            TEXT,
      roi_coordinates   TEXT,
      is_deleted        BOOLEAN     NOT NULL DEFAULT FALSE,
      auto_labeling     BOOLEAN     NOT NULL DEFAULT FALSE,
      is_watched        BOOLEAN     NOT NULL DEFAULT FALSE,
      auto_label_reason TEXT,
      UNIQUE(customer_id, _id)
    )
  `);

  // NAS detection_results 백필: file_name = "{cam}_{event}_{YYYYMMDD}_{HHMMSS}" 형식에서
  // event_name / camera_id / event_time 추출 (원격 고객사의 숫자 _id 형식은 건너뜀)
  await pool.query(`
    UPDATE detection_results
    SET
      camera_id  = split_part(file_name, '_', 1),
      event_name = (regexp_match(file_name, '^[^_]+_(.+)_\\d{8}_\\d{6}$'))[1],
      event_time = CONCAT(
        SUBSTRING((regexp_match(file_name, '_(\\d{8})_\\d{6}$'))[1], 1, 4), '-',
        SUBSTRING((regexp_match(file_name, '_(\\d{8})_\\d{6}$'))[1], 5, 2), '-',
        SUBSTRING((regexp_match(file_name, '_(\\d{8})_\\d{6}$'))[1], 7, 2), ' ',
        SUBSTRING((regexp_match(file_name, '_\\d{8}_(\\d{6})$'))[1], 1, 2), ':',
        SUBSTRING((regexp_match(file_name, '_\\d{8}_(\\d{6})$'))[1], 3, 2), ':',
        SUBSTRING((regexp_match(file_name, '_\\d{8}_(\\d{6})$'))[1], 5, 2)
      )
    WHERE event_name IS NULL
      AND file_name ~ '^.+_.+_[0-9]{8}_[0-9]{6}$'
  `);

  // 중복 버전 정리 후 unique index 생성 (별도 실행: IF NOT EXISTS 는 중복 행 있을 때 실패하므로)
  await pool.query(`
    -- 중복 (customer_id, version) 중 id 가 낮은 행을 삭제
    DELETE FROM prompt_history
    WHERE version IS NOT NULL
      AND id NOT IN (
        SELECT MAX(id)
        FROM prompt_history
        WHERE version IS NOT NULL
        GROUP BY customer_id, version
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_history_version
      ON prompt_history(customer_id, version)
      WHERE version IS NOT NULL;
  `);

  // customers.json → DB 마이그레이션 (한 번만)
  await migrateFromJson(pool);

  // data/cameras/{customerId}.json → cameras 테이블 마이그레이션
  await migrateCamerasFromJson(pool);

  // Notion 프롬프트 기록 → prompts 테이블 시드 (최초 1회)
  await seedPromptsFromNotion(pool);
}

async function migrateCamerasFromJson(pool: Pool) {
  const fs   = await import("fs");
  const path = await import("path");

  const dir = path.join(process.cwd(), "data", "cameras");
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".json"));
  for (const file of files) {
    const customerId = file.replace(".json", "");
    try {
      // customers 테이블에 해당 고객사가 없으면 FK 위반 → 스킵
      const { rows: customerRows } = await pool.query(
        `SELECT id FROM customers WHERE id = $1`, [customerId]
      );
      if (customerRows.length === 0) {
        console.warn(`[db] Camera migration skipped for ${customerId}: customer not found in DB`);
        continue;
      }

      // 이미 마이그레이션된 고객사면 스킵
      const { rows: existingRows } = await pool.query(
        `SELECT COUNT(*) AS c FROM cameras WHERE customer_id = $1`, [customerId]
      );
      if (Number(existingRows[0].c) > 0) continue;

      const cameras = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf-8")
      ) as Array<Record<string, unknown>>;
      for (const c of cameras) {
        const now = new Date().toISOString();
        await pool.query(
          `INSERT INTO cameras
             (id, customer_id, name, mainstream_url, substream_url,
              location, description, enabled, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$8)
           ON CONFLICT (id) DO NOTHING`,
          [
            c.id, customerId, c.name, c.mainstream_url,
            c.substream_url ?? null, c.location ?? null,
            c.description ?? null, c.createdAt ?? now,
          ]
        );
      }
      console.log(`[db] Migrated ${cameras.length} cameras for customer ${customerId}`);
    } catch (e) {
      console.error(`[db] Camera migration failed for ${customerId}:`, e);
    }
  }
}

async function migrateFromJson(pool: Pool) {
  const fs  = await import("fs");
  const path = await import("path");

  const jsonPath = path.join(process.cwd(), "data", "customers.json");
  if (!fs.existsSync(jsonPath)) return;

  const { rows } = await pool.query("SELECT COUNT(*) AS c FROM customers");
  if (Number(rows[0].c) > 0) return; // 이미 마이그레이션 완료

  try {
    const customers = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Record<string, unknown>[];
    for (const c of customers) {
      const vipVal = (c.vip ?? c.dbIp) ?? null;
      await pool.query(
        `INSERT INTO customers
           (id, name, network_type, api_url, ip, rtpulse_port, description, slack_webhook,
            vip, db_ip, db_name, db_port, db_user, db_password,
            ssh_user, ssh_password, nas_path, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO NOTHING`,
        [
          c.id, c.name, (c.networkType ?? "remote"), c.apiUrl, c.ip ?? null,
          c.rtpulsePort ?? null, c.description ?? null, c.slackWebhook ?? null,
          vipVal, c.dbName ?? null, c.dbPort ?? null,
          c.dbUser ?? null, c.dbPassword ?? null,
          c.sshUser ?? null, c.sshPassword ?? null, c.nasPath ?? null,
          c.createdAt,
        ]
      );
    }
    console.log(`[db] Migrated ${customers.length} customers from JSON`);
  } catch (e) {
    console.error("[db] Migration failed:", e);
  }
}

// Notion 프롬프트 기록 시드 (nas_path = '' → 파일 미업로드 상태)
async function seedPromptsFromNotion(pool: Pool) {
  const SEED = [
    { version: "v1.0.0.0", project: "customer-a", assignees: "engineer-1", applied_at: "2025-01-06", base_prompt: "v0.0.0.0" },
    { version: "v1.0.1.0", project: "customer-a", assignees: "engineer-2", applied_at: "2025-01-20", base_prompt: "v1.0.0.0" },
    { version: "v1.0.2.0", project: "customer-b", assignees: "engineer-1", applied_at: "2025-02-03", base_prompt: "v1.0.0.0" },
  ];

  const now = new Date().toISOString();
  let inserted = 0;
  for (const r of SEED) {
    try {
      const result = await pool.query(
        `INSERT INTO prompts (project_name, version, assignees, applied_at, nas_path, base_prompt, registered_at)
         VALUES ($1, $2, $3, $4, '', $5, $6)
         ON CONFLICT (project_name, version) DO NOTHING`,
        [r.project, r.version, r.assignees, r.applied_at, r.base_prompt, now]
      );
      if ((result.rowCount ?? 0) > 0) inserted++;
    } catch (e) {
      console.error(`[db] Prompt seed failed for ${r.project}/${r.version}:`, e);
    }
  }
  if (inserted > 0) console.log(`[db] Seeded ${inserted} prompt records from Notion`);
}
