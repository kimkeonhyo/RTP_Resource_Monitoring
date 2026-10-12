use crate::app::StreamHealth;
use anyhow::Result;
use chrono::{DateTime, Duration, Local, TimeZone, Timelike};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

const TIMELINE_LIMIT: usize = 50;

// ---------------------------------------------------------------------------
// Event kind
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionEventKind {
    Down,
    Warning,
    Reconnect,
}

impl ConnectionEventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Down => "down",
            Self::Warning => "warning",
            Self::Reconnect => "reconnect",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "warning" => Self::Warning,
            "reconnect" | "up" => Self::Reconnect, // "up" for backward compat
            _ => Self::Down,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Down => "DOWN",
            Self::Warning => "WARNING",
            Self::Reconnect => "RECONNECT",
        }
    }
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StatsFilter {
    Day1,
    Day7,
    Day15,
    #[default]
    Day30,
}

impl StatsFilter {
    pub fn label(self) -> &'static str {
        match self {
            Self::Day1 => "1D",
            Self::Day7 => "7D",
            Self::Day15 => "15D",
            Self::Day30 => "30D",
        }
    }

    /// How many days ago to start from (0 = today only).
    pub fn days_ago(self) -> i64 {
        match self {
            Self::Day1 => 0,
            Self::Day7 => 6,
            Self::Day15 => 14,
            Self::Day30 => 29,
        }
    }

    pub fn next(self) -> Self {
        match self {
            Self::Day1 => Self::Day7,
            Self::Day7 => Self::Day15,
            Self::Day15 => Self::Day30,
            Self::Day30 => Self::Day1,
        }
    }
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct DownSummary {
    pub downs_today: usize,
    pub downs_last_7d: usize,
    pub downs_last_30d: usize,
    pub last_down_epoch: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct StreamEventCounts {
    pub stream_id: usize,
    pub down_count: usize,
    pub warn_count: usize,
    pub reconnect_count: usize,
    pub last_event_epoch: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct EventLogEntry {
    pub stream_name: String,
    pub event_kind: ConnectionEventKind,
    pub from_health: String,
    pub to_health: String,
    pub happened_at_epoch: i64,
}

impl EventLogEntry {
    pub fn cause(&self) -> &'static str {
        match self.event_kind {
            ConnectionEventKind::Down => match self.from_health.as_str() {
                "DEGRADED" => "Progressive failure",
                _ => "Sudden dropout",
            },
            ConnectionEventKind::Warning => match self.from_health.as_str() {
                "DOWN" => "Partial recovery",
                _ => "Signal degraded",
            },
            ConnectionEventKind::Reconnect => match self.to_health.as_str() {
                "HEALTHY" => "Fully recovered",
                _ => "Partial recovery",
            },
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct StatsTrend {
    pub values: Vec<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct StatsSnapshot {
    pub summary: DownSummary,
    pub stream_counts: Vec<StreamEventCounts>,
    pub daily_trend: StatsTrend,
    pub weekly_trend: StatsTrend,
    pub monthly_trend: StatsTrend,
    pub filter_trend: StatsTrend,
    pub event_log: Vec<EventLogEntry>,
    pub error: Option<String>,
}

pub struct ConnectionEvent<'a> {
    pub stream_id: usize,
    pub stream_name: &'a str,
    pub stream_url: &'a str,
    pub kind: ConnectionEventKind,
    pub from_health: StreamHealth,
    pub to_health: StreamHealth,
    pub happened_at_epoch: i64,
}

/// Raw row from `connection_events` used only for Excel export.
#[derive(Debug, Clone)]
pub struct RawConnectionEvent {
    pub stream_name: String,
    pub stream_url: String,
    pub event_kind: String,
    pub happened_at_epoch: i64,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct StatsStore {
    conn: Connection,
}

impl StatsStore {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;
        let store = Self { conn };
        store.migrate_schema()?;
        store.init_schema()?;
        Ok(store)
    }

    /// Migrate old schema (CHECK constraint limited to 'down'/'up') to the
    /// new schema that allows 'warning' and 'reconnect'.  Also renames
    /// existing 'up' rows to 'reconnect' for consistency.
    fn migrate_schema(&self) -> Result<()> {
        let sql: String = self
            .conn
            .query_row(
                "SELECT COALESCE(sql, '') FROM sqlite_master
                 WHERE type='table' AND name='connection_events'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_default();

        if sql.contains("CHECK") {
            // Recreate table without the CHECK constraint, preserving data
            self.conn.execute_batch(
                "BEGIN;
                 ALTER TABLE connection_events
                     RENAME TO connection_events_old;
                 CREATE TABLE connection_events (
                     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                     stream_id          INTEGER NOT NULL,
                     stream_name        TEXT    NOT NULL,
                     stream_url         TEXT    NOT NULL,
                     event_kind         TEXT    NOT NULL,
                     from_health        TEXT    NOT NULL,
                     to_health          TEXT    NOT NULL,
                     happened_at_epoch  INTEGER NOT NULL
                 );
                 INSERT INTO connection_events
                     SELECT id, stream_id, stream_name, stream_url,
                            CASE event_kind WHEN 'up' THEN 'reconnect' ELSE event_kind END,
                            from_health, to_health, happened_at_epoch
                     FROM connection_events_old;
                 DROP TABLE connection_events_old;
                 COMMIT;",
            )?;
        } else if !sql.is_empty() {
            // Table exists but no CHECK constraint — just rename 'up' → 'reconnect'
            self.conn.execute(
                "UPDATE connection_events SET event_kind='reconnect'
                 WHERE event_kind='up'",
                [],
            )?;
        }

        Ok(())
    }

    fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS connection_events (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                stream_id          INTEGER NOT NULL,
                stream_name        TEXT    NOT NULL,
                stream_url         TEXT    NOT NULL,
                event_kind         TEXT    NOT NULL,
                from_health        TEXT    NOT NULL,
                to_health          TEXT    NOT NULL,
                happened_at_epoch  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_connection_events_kind_epoch
                ON connection_events(event_kind, happened_at_epoch DESC);
            CREATE INDEX IF NOT EXISTS idx_connection_events_stream_epoch
                ON connection_events(stream_id, happened_at_epoch DESC);",
        )?;
        Ok(())
    }

    pub fn record_event(&self, event: &ConnectionEvent<'_>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO connection_events (
                stream_id, stream_name, stream_url, event_kind, from_health, to_health, happened_at_epoch
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.stream_id as i64,
                event.stream_name,
                event.stream_url,
                event.kind.as_str(),
                event.from_health.label(),
                event.to_health.label(),
                event.happened_at_epoch
            ],
        )?;
        Ok(())
    }

    pub fn read_snapshot(
        &self,
        now: DateTime<Local>,
        filter: StatsFilter,
    ) -> Result<StatsSnapshot> {
        let today_start = start_of_today_epoch(now)?;
        let last_7d_start = start_of_day_days_ago_epoch(now, 6)?;
        let last_30d_start = start_of_day_days_ago_epoch(now, 29)?;
        let filter_start = start_of_day_days_ago_epoch(now, filter.days_ago())?;

        let month_down_epochs = self.read_event_epochs(last_30d_start, "down")?;

        Ok(StatsSnapshot {
            summary: self.read_summary(today_start, last_7d_start, last_30d_start)?,
            stream_counts: self.read_stream_event_counts(filter_start)?,
            daily_trend: build_hourly_trend(now, &month_down_epochs),
            weekly_trend: build_daily_trend(now, 7, &month_down_epochs),
            monthly_trend: build_daily_trend(now, 30, &month_down_epochs),
            filter_trend: self.build_filter_trend(now, filter, filter_start)?,
            event_log: self.read_event_log(filter_start, TIMELINE_LIMIT)?,
            error: None,
        })
    }

    fn read_summary(
        &self,
        today_start: i64,
        last_7d_start: i64,
        last_30d_start: i64,
    ) -> Result<DownSummary> {
        let downs_today: usize = self.conn.query_row(
            "SELECT COUNT(*) FROM connection_events
             WHERE event_kind = 'down' AND happened_at_epoch >= ?1",
            params![today_start],
            |row| row.get(0),
        )?;

        let downs_last_7d: usize = self.conn.query_row(
            "SELECT COUNT(*) FROM connection_events
             WHERE event_kind = 'down' AND happened_at_epoch >= ?1",
            params![last_7d_start],
            |row| row.get(0),
        )?;

        let downs_last_30d: usize = self.conn.query_row(
            "SELECT COUNT(*) FROM connection_events
             WHERE event_kind = 'down' AND happened_at_epoch >= ?1",
            params![last_30d_start],
            |row| row.get(0),
        )?;

        let last_down_epoch = self
            .conn
            .query_row(
                "SELECT happened_at_epoch FROM connection_events
                 WHERE event_kind = 'down'
                 ORDER BY happened_at_epoch DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;

        Ok(DownSummary {
            downs_today,
            downs_last_7d,
            downs_last_30d,
            last_down_epoch,
        })
    }

    fn read_stream_event_counts(&self, since_epoch: i64) -> Result<Vec<StreamEventCounts>> {
        let mut stmt = self.conn.prepare(
            "SELECT
                stream_id,
                SUM(CASE WHEN event_kind = 'down' THEN 1 ELSE 0 END)      AS downs,
                SUM(CASE WHEN event_kind = 'warning' THEN 1 ELSE 0 END)   AS warns,
                SUM(CASE WHEN event_kind = 'reconnect' THEN 1 ELSE 0 END) AS reconnects,
                MAX(happened_at_epoch) AS last_event
             FROM connection_events
             WHERE happened_at_epoch >= ?1
             GROUP BY stream_id",
        )?;

        let rows = stmt.query_map(params![since_epoch], |row| {
            Ok(StreamEventCounts {
                stream_id: row.get::<_, i64>(0)? as usize,
                down_count: row.get::<_, i64>(1)? as usize,
                warn_count: row.get::<_, i64>(2)? as usize,
                reconnect_count: row.get::<_, i64>(3)? as usize,
                last_event_epoch: row.get(4)?,
            })
        })?;

        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn read_event_epochs(&self, since_epoch: i64, kind: &str) -> Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(
            "SELECT happened_at_epoch FROM connection_events
             WHERE event_kind = ?1 AND happened_at_epoch >= ?2
             ORDER BY happened_at_epoch ASC",
        )?;
        let rows = stmt.query_map(params![kind, since_epoch], |row| row.get(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn build_filter_trend(
        &self,
        now: DateTime<Local>,
        filter: StatsFilter,
        filter_start: i64,
    ) -> Result<StatsTrend> {
        // Collect epochs for all event kinds in the filter period
        let mut stmt = self.conn.prepare(
            "SELECT happened_at_epoch FROM connection_events
             WHERE happened_at_epoch >= ?1
             ORDER BY happened_at_epoch ASC",
        )?;
        let epochs: Vec<i64> = stmt
            .query_map(params![filter_start], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(match filter {
            StatsFilter::Day1 => build_hourly_trend(now, &epochs),
            StatsFilter::Day7 => build_daily_trend(now, 7, &epochs),
            StatsFilter::Day15 => build_daily_trend(now, 15, &epochs),
            StatsFilter::Day30 => build_daily_trend(now, 30, &epochs),
        })
    }

    fn read_event_log(&self, since_epoch: i64, limit: usize) -> Result<Vec<EventLogEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT stream_name, event_kind, from_health, to_health, happened_at_epoch
             FROM connection_events
             WHERE happened_at_epoch >= ?1
             ORDER BY happened_at_epoch DESC
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![since_epoch, limit as i64], |row| {
            let kind_str: String = row.get(1)?;
            Ok(EventLogEntry {
                stream_name: row.get(0)?,
                event_kind: ConnectionEventKind::from_str(&kind_str),
                from_health: row.get(2)?,
                to_health: row.get(3)?,
                happened_at_epoch: row.get(4)?,
            })
        })?;

        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Returns every row in `connection_events` ordered chronologically.
    /// Used exclusively by the Excel export.
    pub fn read_all_events(&self) -> Result<Vec<RawConnectionEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT stream_name, stream_url, event_kind, happened_at_epoch
             FROM connection_events
             ORDER BY happened_at_epoch ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(RawConnectionEvent {
                stream_name: row.get(0)?,
                stream_url: row.get(1)?,
                event_kind: row.get(2)?,
                happened_at_epoch: row.get(3)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }
}

// ---------------------------------------------------------------------------
// Event kind mapping
// ---------------------------------------------------------------------------

pub fn connection_event_kind(from: StreamHealth, to: StreamHealth) -> Option<ConnectionEventKind> {
    match (from, to) {
        (StreamHealth::Unknown, _) | (_, StreamHealth::Unknown) => None,
        // Down → anything: reconnect
        (StreamHealth::Down, next) if next != StreamHealth::Down => {
            Some(ConnectionEventKind::Reconnect)
        }
        // Anything → Down: down
        (prev, StreamHealth::Down) if prev != StreamHealth::Down => {
            Some(ConnectionEventKind::Down)
        }
        // Anything → Degraded (not from Down, handled above): warning
        (prev, StreamHealth::Degraded) if prev != StreamHealth::Degraded => {
            Some(ConnectionEventKind::Warning)
        }
        // Degraded → Healthy: reconnect (recovery)
        (StreamHealth::Degraded, StreamHealth::Healthy) => Some(ConnectionEventKind::Reconnect),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

pub fn start_of_today_epoch(now: DateTime<Local>) -> Result<i64> {
    let start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("valid midnight");
    let local = Local
        .from_local_datetime(&start)
        .earliest()
        .or_else(|| Local.from_local_datetime(&start).latest())
        .ok_or_else(|| anyhow::anyhow!("failed to resolve local midnight"))?;
    Ok(local.timestamp())
}

pub fn start_of_day_days_ago_epoch(now: DateTime<Local>, days_ago: i64) -> Result<i64> {
    let shifted = now - Duration::days(days_ago);
    start_of_today_epoch(shifted)
}

fn build_hourly_trend(now: DateTime<Local>, epochs: &[i64]) -> StatsTrend {
    let mut values = vec![0u64; 24];
    for &epoch in epochs {
        if let Some(local) = local_datetime(epoch) {
            if local.date_naive() == now.date_naive() {
                values[local.hour() as usize] += 1;
            }
        }
    }
    StatsTrend { values }
}

fn build_daily_trend(now: DateTime<Local>, days: usize, epochs: &[i64]) -> StatsTrend {
    let mut values = vec![0u64; days];
    let start_date = now.date_naive() - Duration::days((days.saturating_sub(1)) as i64);

    for &epoch in epochs {
        if let Some(local) = local_datetime(epoch) {
            let event_date = local.date_naive();
            if event_date < start_date || event_date > now.date_naive() {
                continue;
            }
            let index = (event_date - start_date).num_days() as usize;
            if let Some(bucket) = values.get_mut(index) {
                *bucket += 1;
            }
        }
    }

    StatsTrend { values }
}

fn local_datetime(epoch: i64) -> Option<DateTime<Local>> {
    Local
        .timestamp_opt(epoch, 0)
        .single()
        .or_else(|| Local.timestamp_opt(epoch, 0).earliest())
        .or_else(|| Local.timestamp_opt(epoch, 0).latest())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("rtpulse-{name}-{nanos}.sqlite3"))
    }

    #[test]
    fn connection_event_mapping() {
        assert_eq!(
            connection_event_kind(StreamHealth::Unknown, StreamHealth::Healthy),
            None
        );
        assert_eq!(
            connection_event_kind(StreamHealth::Healthy, StreamHealth::Down),
            Some(ConnectionEventKind::Down)
        );
        assert_eq!(
            connection_event_kind(StreamHealth::Down, StreamHealth::Down),
            None
        );
        assert_eq!(
            connection_event_kind(StreamHealth::Down, StreamHealth::Degraded),
            Some(ConnectionEventKind::Reconnect)
        );
        assert_eq!(
            connection_event_kind(StreamHealth::Degraded, StreamHealth::Down),
            Some(ConnectionEventKind::Down)
        );
        assert_eq!(
            connection_event_kind(StreamHealth::Healthy, StreamHealth::Degraded),
            Some(ConnectionEventKind::Warning)
        );
        assert_eq!(
            connection_event_kind(StreamHealth::Degraded, StreamHealth::Healthy),
            Some(ConnectionEventKind::Reconnect)
        );
    }

    #[test]
    fn store_persists_and_queries_events() {
        let path = temp_db_path("stats-store");
        let store = StatsStore::open(&path).expect("open db");
        let now = Local::now();
        let today_start = start_of_today_epoch(now).expect("today");

        store
            .record_event(&ConnectionEvent {
                stream_id: 1,
                stream_name: "cam-a",
                stream_url: "rtsp://cam-a/live",
                kind: ConnectionEventKind::Down,
                from_health: StreamHealth::Healthy,
                to_health: StreamHealth::Down,
                happened_at_epoch: today_start + 30,
            })
            .expect("record down");
        store
            .record_event(&ConnectionEvent {
                stream_id: 1,
                stream_name: "cam-a",
                stream_url: "rtsp://cam-a/live",
                kind: ConnectionEventKind::Reconnect,
                from_health: StreamHealth::Down,
                to_health: StreamHealth::Healthy,
                happened_at_epoch: today_start + 90,
            })
            .expect("record reconnect");
        store
            .record_event(&ConnectionEvent {
                stream_id: 2,
                stream_name: "cam-b",
                stream_url: "rtsp://cam-b/live",
                kind: ConnectionEventKind::Warning,
                from_health: StreamHealth::Healthy,
                to_health: StreamHealth::Degraded,
                happened_at_epoch: today_start + 120,
            })
            .expect("record warning");

        let snapshot = store
            .read_snapshot(now, StatsFilter::Day30)
            .expect("snapshot");

        assert_eq!(snapshot.summary.downs_today, 1);
        assert_eq!(snapshot.event_log.len(), 3);
        assert_eq!(snapshot.stream_counts.len(), 2);

        let cam_a = snapshot
            .stream_counts
            .iter()
            .find(|r| r.stream_id == 1)
            .expect("cam-a counts");
        assert_eq!(cam_a.down_count, 1);
        assert_eq!(cam_a.reconnect_count, 1);

        let cam_b = snapshot
            .stream_counts
            .iter()
            .find(|r| r.stream_id == 2)
            .expect("cam-b counts");
        assert_eq!(cam_b.warn_count, 1);

        fs::remove_file(path).expect("cleanup");
    }
}
