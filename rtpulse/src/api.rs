//! Lightweight HTTP API server for the rtpulse web dashboard.
//!
//! Start with `--api-port <PORT>` (e.g. `--api-port 8080`).
//! Endpoints:
//!   GET /api/info        – version + stream count
//!   GET /api/streams     – per-stream health + metrics
//!   GET /api/aggregate   – aggregate metrics
//!   GET /api/logs        – recent log lines (?limit=N, default 200)
//!   GET /api/stats       – stats snapshot (?filter=1d|7d|15d|30d, default 30d)

use crate::alert::SharedSlackWebhook;
use crate::app::{AggregateMetrics, StatsView, StreamEntry};
use crate::stats::StatsFilter;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::Method,
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, RwLock};
use tower_http::cors::{Any, CorsLayer};

// ---------------------------------------------------------------------------
// DTO types (match the TypeScript interfaces in rtpulse-web/src/lib/types.ts)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Default)]
pub struct ApiInfo {
    pub version: String,
    pub stream_count: usize,
    pub captured_at: i64,
}

#[derive(Serialize, Clone, Default)]
pub struct ApiStream {
    pub id: usize,
    pub name: String,
    pub url: String,
    pub protocol: String,
    pub health: String,
    pub bitrate_kbps: f64,
    pub packet_loss_pct: f64,
    pub jitter_ms: f64,
    pub fps: f64,
    pub uptime_secs: u64,
    pub last_update: i64,
}

#[derive(Serialize, Clone, Default)]
pub struct ApiAggregate {
    pub total: usize,
    pub healthy: usize,
    pub degraded: usize,
    pub down: usize,
    pub unknown: usize,
    pub total_bitrate_kbps: f64,
    pub avg_loss_pct: f64,
    pub avg_jitter_ms: f64,
}

#[derive(Serialize, Clone, Default)]
pub struct ApiDownSummary {
    pub downs_today: usize,
    pub downs_last_7d: usize,
    pub downs_last_30d: usize,
    pub last_down_epoch: Option<i64>,
}

#[derive(Serialize, Clone, Default)]
pub struct ApiStatsRow {
    pub stream_id: usize,
    pub stream_name: String,
    pub down_count: usize,
    pub warn_count: usize,
    pub reconnect_count: usize,
    pub last_event_epoch: Option<i64>,
}

#[derive(Serialize, Clone, Default)]
pub struct ApiEventLogEntry {
    pub stream_name: String,
    pub event_kind: String,
    pub cause: String,
    pub happened_at_epoch: i64,
}

#[derive(Serialize, Clone, Default)]
pub struct ApiStats {
    pub filter: String,
    pub summary: ApiDownSummary,
    pub stream_rows: Vec<ApiStatsRow>,
    pub filter_trend: Vec<u64>,
    pub event_log: Vec<ApiEventLogEntry>,
}

/// Full snapshot shared between the event loop and the HTTP handlers.
#[derive(Clone, Default)]
pub struct ApiSnapshot {
    pub info: ApiInfo,
    pub streams: Vec<ApiStream>,
    pub aggregate: ApiAggregate,
    pub logs: VecDeque<String>,
    pub stats: ApiStats,
}

pub type SharedApiState = Arc<RwLock<ApiSnapshot>>;

/// Command to add a new stream at runtime (sent from HTTP API → TUI event loop).
#[derive(Clone)]
pub struct AddStreamCmd {
    pub name: String,
    pub url: String,
}

/// Thread-safe queue of pending stream additions.
pub type CommandQueue = Arc<Mutex<Vec<AddStreamCmd>>>;

/// Thread-safe queue of stream IDs to remove.
pub type RemoveCommandQueue = Arc<Mutex<Vec<usize>>>;

// ---------------------------------------------------------------------------
// Builder helpers (called from app.rs)
// ---------------------------------------------------------------------------

pub fn stream_to_api(entry: &StreamEntry) -> ApiStream {
    ApiStream {
        id: entry.id,
        name: entry.name.clone(),
        url: entry.url.clone(),
        protocol: entry.protocol.to_string(),
        health: entry.health.label().to_string(),
        bitrate_kbps: entry.metrics.bitrate_kbps,
        packet_loss_pct: entry.metrics.packet_loss_pct,
        jitter_ms: entry.metrics.jitter_ms,
        fps: entry.metrics.fps,
        uptime_secs: entry.metrics.uptime_secs,
        last_update: entry.metrics.last_update.timestamp(),
    }
}

pub fn aggregate_to_api(
    agg: &AggregateMetrics,
    healthy: usize,
    degraded: usize,
    down: usize,
    unknown: usize,
) -> ApiAggregate {
    ApiAggregate {
        total: healthy + degraded + down + unknown,
        healthy,
        degraded,
        down,
        unknown,
        total_bitrate_kbps: agg.total_bitrate_kbps,
        avg_loss_pct: agg.avg_loss_pct,
        avg_jitter_ms: agg.avg_jitter_ms,
    }
}

pub fn stats_view_to_api(view: &StatsView, filter: StatsFilter) -> ApiStats {
    ApiStats {
        filter: filter.label().to_string(),
        summary: ApiDownSummary {
            downs_today: view.summary.downs_today,
            downs_last_7d: view.summary.downs_last_7d,
            downs_last_30d: view.summary.downs_last_30d,
            last_down_epoch: view.summary.last_down_epoch,
        },
        stream_rows: view
            .rows
            .iter()
            .map(|r| ApiStatsRow {
                stream_id: r.stream_id,
                stream_name: r.stream_name.clone(),
                down_count: r.down_count,
                warn_count: r.warn_count,
                reconnect_count: r.reconnect_count,
                last_event_epoch: r.last_event_epoch,
            })
            .collect(),
        filter_trend: view.filter_trend.values.clone(),
        event_log: view
            .event_log
            .iter()
            .map(|e| ApiEventLogEntry {
                stream_name: e.stream_name.clone(),
                event_kind: e.event_kind.label().to_string(),
                cause: e.cause().to_string(),
                happened_at_epoch: e.happened_at_epoch,
            })
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// Axum handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LogsQuery {
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct AddStreamBody {
    name: String,
    url: String,
}

#[derive(Deserialize)]
struct SetAlertsBody {
    /// Slack incoming webhook URL to use for runtime alerts
    slack_webhook: Option<String>,
}

#[derive(Clone)]
struct ApiServerState {
    snapshot: SharedApiState,
    commands: CommandQueue,
    remove_commands: RemoveCommandQueue,
    dynamic_slack: SharedSlackWebhook,
}

async fn post_streams(
    State(s): State<ApiServerState>,
    Json(body): Json<AddStreamBody>,
) -> Json<serde_json::Value> {
    s.commands.lock().unwrap().push(AddStreamCmd {
        name: body.name.clone(),
        url: body.url.clone(),
    });
    Json(serde_json::json!({ "ok": true, "name": body.name, "url": body.url }))
}

async fn delete_stream_h(
    State(s): State<ApiServerState>,
    Path(id): Path<usize>,
) -> Json<serde_json::Value> {
    s.remove_commands.lock().unwrap().push(id);
    Json(serde_json::json!({ "ok": true, "removed_id": id }))
}

async fn post_alerts(
    State(s): State<ApiServerState>,
    Json(body): Json<SetAlertsBody>,
) -> Json<serde_json::Value> {
    if let Ok(mut guard) = s.dynamic_slack.write() {
        *guard = body.slack_webhook.clone();
    }
    let configured = body.slack_webhook.is_some();
    Json(serde_json::json!({ "ok": true, "slack_configured": configured }))
}

// Wrap handlers that only need the snapshot
async fn get_info_h(State(s): State<ApiServerState>) -> Json<ApiInfo> {
    Json(s.snapshot.read().unwrap().info.clone())
}
async fn get_streams_h(State(s): State<ApiServerState>) -> Json<Vec<ApiStream>> {
    Json(s.snapshot.read().unwrap().streams.clone())
}
async fn get_aggregate_h(State(s): State<ApiServerState>) -> Json<ApiAggregate> {
    Json(s.snapshot.read().unwrap().aggregate.clone())
}
async fn get_logs_h(
    State(s): State<ApiServerState>,
    Query(q): Query<LogsQuery>,
) -> Json<Vec<String>> {
    let limit = q.limit.unwrap_or(200);
    let guard = s.snapshot.read().unwrap();
    Json(guard.logs.iter().rev().take(limit).cloned().collect())
}
async fn get_stats_h(State(s): State<ApiServerState>) -> Json<ApiStats> {
    Json(s.snapshot.read().unwrap().stats.clone())
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

pub async fn serve(
    port: u16,
    state: SharedApiState,
    commands: CommandQueue,
    remove_commands: RemoveCommandQueue,
    dynamic_slack: SharedSlackWebhook,
) {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers(Any)
        .allow_origin(Any);

    let server_state = ApiServerState {
        snapshot: state,
        commands,
        remove_commands,
        dynamic_slack,
    };

    let router = Router::new()
        .route("/api/info", get(get_info_h))
        .route("/api/streams", get(get_streams_h).post(post_streams))
        .route("/api/streams/{id}", delete(delete_stream_h))
        .route("/api/aggregate", get(get_aggregate_h))
        .route("/api/logs", get(get_logs_h))
        .route("/api/stats", get(get_stats_h))
        .route("/api/alerts", post(post_alerts))
        .layer(cors)
        .with_state(server_state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("API server listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind API port");
    axum::serve(listener, router)
        .await
        .expect("API server error");
}
