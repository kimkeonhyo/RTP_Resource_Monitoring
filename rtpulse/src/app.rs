use crate::alert::{AlertConfig, AlertEngine, SharedSlackWebhook, spawn_alert_dispatcher};
use crate::batch::{BatchReceiver, RtpEndpoint, SharedMetricsMap};
#[cfg(feature = "pcap-capture")]
use crate::capture::{CaptureMonitor, SharedCaptureMetrics, StreamEndpoint};
use crate::monitor::{MonitorHandle, StreamMonitor};
use crate::api::{SharedApiState, aggregate_to_api, stats_view_to_api, stream_to_api};
use crate::stats::{
    DownSummary, EventLogEntry, StatsFilter, StatsSnapshot, StatsStore, StatsTrend,
    StreamEventCounts, connection_event_kind,
};
use anyhow::Result;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::thread::JoinHandle;

/// Maximum number of data points to keep in history for sparklines
const MAX_HISTORY: usize = 120;
const STATS_DB_PATH: &str = "rtpulse.sqlite3";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamHealth {
    Healthy,
    Degraded,
    Down,
    Unknown,
}

impl StreamHealth {
    pub fn symbol(&self) -> &str {
        match self {
            StreamHealth::Healthy => "●",
            StreamHealth::Degraded => "▲",
            StreamHealth::Down => "✖",
            StreamHealth::Unknown => "?",
        }
    }

    pub fn label(&self) -> &str {
        match self {
            StreamHealth::Healthy => "HEALTHY",
            StreamHealth::Degraded => "DEGRADED",
            StreamHealth::Down => "DOWN",
            StreamHealth::Unknown => "UNKNOWN",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamProtocol {
    Rtp,
    Rtsp,
}

impl std::fmt::Display for StreamProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StreamProtocol::Rtp => write!(f, "RTP"),
            StreamProtocol::Rtsp => write!(f, "RTSP"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct StreamMetrics {
    pub bitrate_kbps: f64,
    pub packet_loss_pct: f64,
    pub jitter_ms: f64,
    pub latency_ms: f64,
    pub fps: f64,
    pub packets_received: u64,
    pub packets_lost: u64,
    pub uptime_secs: u64,
    pub last_update: DateTime<Local>,

    // History for sparklines
    pub bitrate_history: VecDeque<f64>,
    pub jitter_history: VecDeque<f64>,
    pub loss_history: VecDeque<f64>,
    pub fps_history: VecDeque<f64>,
}

impl Default for StreamMetrics {
    fn default() -> Self {
        Self {
            bitrate_kbps: 0.0,
            packet_loss_pct: 0.0,
            jitter_ms: 0.0,
            latency_ms: 0.0,
            fps: 0.0,
            packets_received: 0,
            packets_lost: 0,
            uptime_secs: 0,
            last_update: Local::now(),
            bitrate_history: VecDeque::with_capacity(MAX_HISTORY),
            jitter_history: VecDeque::with_capacity(MAX_HISTORY),
            loss_history: VecDeque::with_capacity(MAX_HISTORY),
            fps_history: VecDeque::with_capacity(MAX_HISTORY),
        }
    }
}

impl StreamMetrics {
    pub fn push_history(&mut self) {
        let push = |history: &mut VecDeque<f64>, val: f64| {
            if history.len() >= MAX_HISTORY {
                history.pop_front();
            }
            history.push_back(val);
        };
        push(&mut self.bitrate_history, self.bitrate_kbps);
        push(&mut self.jitter_history, self.jitter_ms);
        push(&mut self.loss_history, self.packet_loss_pct);
        push(&mut self.fps_history, self.fps);
    }
}

#[derive(Debug, Clone)]
pub struct StreamEntry {
    pub id: usize,
    pub url: String,
    pub name: String,
    pub protocol: StreamProtocol,
    pub health: StreamHealth,
    pub metrics: StreamMetrics,
    #[allow(dead_code)]
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppTab {
    Dashboard,
    Overview,
    Detail,
    Logs,
    Stats,
}

impl AppTab {
    pub fn titles() -> Vec<&'static str> {
        vec![
            "Dashboard [1]",
            "Overview [2]",
            "Detail [3]",
            "Logs [4]",
            "Stats [5]",
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
pub enum SortMode {
    ById,
    ByHealth,
    ByBitrate,
    ByLoss,
}

impl SortMode {
    pub fn next(&self) -> Self {
        match self {
            SortMode::ById => SortMode::ByHealth,
            SortMode::ByHealth => SortMode::ByBitrate,
            SortMode::ByBitrate => SortMode::ByLoss,
            SortMode::ByLoss => SortMode::ById,
        }
    }

    pub fn label(&self) -> &str {
        match self {
            SortMode::ById => "ID",
            SortMode::ByHealth => "Health",
            SortMode::ByBitrate => "Bitrate",
            SortMode::ByLoss => "Pkt Loss",
        }
    }
}

#[derive(Deserialize, Serialize)]
struct StreamConfig {
    streams: Vec<StreamUrl>,
    #[serde(default)]
    alerts: Option<AlertConfig>,
}

#[derive(Deserialize, Serialize)]
struct StreamUrl {
    url: String,
    name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct StatsRow {
    pub stream_id: usize,
    pub stream_name: String,
    pub down_count: usize,
    pub warn_count: usize,
    pub reconnect_count: usize,
    pub last_event_epoch: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct StatsView {
    pub summary: DownSummary,
    pub filter_trend: StatsTrend,
    pub daily_trend: StatsTrend,
    pub weekly_trend: StatsTrend,
    pub monthly_trend: StatsTrend,
    pub rows: Vec<StatsRow>,
    pub event_log: Vec<EventLogEntry>,
    pub error: Option<String>,
}

pub struct App {
    pub streams: Vec<StreamEntry>,
    pub selected: usize,
    pub tab: AppTab,
    pub sort_mode: SortMode,
    pub paused: bool,
    pub show_add_dialog: bool,
    pub input_buffer: String,
    pub logs: VecDeque<String>,
    pub stats_view: StatsView,
    pub stats_filter: StatsFilter,
    pub tick_count: u64,
    pub interval_ms: u64,
    pub demo_mode: bool,
    next_id: usize,
    monitors: Vec<MonitorHandle>,
    stats_store: Option<StatsStore>,
    stats_dirty: bool,
    // Production mode: batch receiver for RTP streams (socket-based)
    batch_metrics: Option<SharedMetricsMap>,
    #[allow(dead_code)]
    batch_thread: Option<JoinHandle<()>>,
    // Capture mode: pcap-based monitoring for RTSP+RTP
    #[cfg(feature = "pcap-capture")]
    capture_interface: Option<String>,
    #[cfg(feature = "pcap-capture")]
    capture_metrics: Option<SharedCaptureMetrics>,
    #[cfg(feature = "pcap-capture")]
    #[allow(dead_code)]
    capture_thread: Option<JoinHandle<()>>,
    // Alert engine
    alert_engine: Option<AlertEngine>,
    alert_config: Option<AlertConfig>,
    /// Path to the loaded config file — used to persist stream deletions
    config_path: Option<String>,
    /// Runtime-configurable Slack webhook (shared with API server)
    pub dynamic_slack: SharedSlackWebhook,
    /// URLs of streams that were added via API polling (not from config / CLI).
    /// Used to restrict poll-driven removals and to exclude them from save_config.
    polled_urls: HashSet<String>,
    // Live discover state
    #[cfg(feature = "pcap-capture")]
    pub discovering: bool,
    #[cfg(feature = "pcap-capture")]
    _discover_rx: Option<std::sync::mpsc::Receiver<Vec<String>>>,
}

/// Parse AlertConfig from a file that supports two formats:
/// - Wrapped:  top-level "alerts:" key (same as main config)
/// - Direct:   AlertConfig fields at the root level
fn parse_alert_config(data: &str) -> anyhow::Result<AlertConfig> {
    #[derive(serde::Deserialize)]
    struct Wrapper {
        alerts: AlertConfig,
    }
    // Try wrapped format first
    if let Ok(w) = serde_yaml::from_str::<Wrapper>(data) {
        return Ok(w.alerts);
    }
    // Fall back to direct format
    Ok(serde_yaml::from_str::<AlertConfig>(data)?)
}

impl App {
    pub fn new(interval_ms: u64, demo_mode: bool, _interface: Option<String>) -> Self {
        let mut app = Self {
            streams: Vec::new(),
            selected: 0,
            tab: AppTab::Dashboard,
            sort_mode: SortMode::ById,
            paused: false,
            show_add_dialog: false,
            input_buffer: String::new(),
            logs: VecDeque::with_capacity(500),
            stats_view: StatsView::default(),
            stats_filter: StatsFilter::default(),
            tick_count: 0,
            interval_ms,
            demo_mode,
            next_id: 0,
            monitors: Vec::new(),
            stats_store: None,
            stats_dirty: true,
            batch_metrics: None,
            batch_thread: None,
            #[cfg(feature = "pcap-capture")]
            capture_interface: _interface,
            #[cfg(feature = "pcap-capture")]
            capture_metrics: None,
            #[cfg(feature = "pcap-capture")]
            capture_thread: None,
            alert_engine: None,
            alert_config: None,
            config_path: None,
            dynamic_slack: std::sync::Arc::new(std::sync::RwLock::new(None)),
            polled_urls: HashSet::new(),
            #[cfg(feature = "pcap-capture")]
            discovering: false,
            #[cfg(feature = "pcap-capture")]
            _discover_rx: None,
        };

        match StatsStore::open(STATS_DB_PATH) {
            Ok(store) => {
                app.stats_store = Some(store);
                app.log(format!("Stats recording enabled ({STATS_DB_PATH})"));
            }
            Err(err) => {
                app.log(format!("Stats DB unavailable: {err}"));
                app.stats_view.error = Some(format!("Stats DB unavailable: {err}"));
            }
        }

        app.refresh_stats_view();
        app
    }

    pub fn load_config(&mut self, path: &str) -> Result<()> {
        let data = std::fs::read_to_string(path)?;
        let config: StreamConfig = serde_yaml::from_str(&data)?;
        for s in config.streams {
            let name = s.name.unwrap_or_else(|| self.derive_name(&s.url));
            self.add_stream_with_name(&s.url, &name);
        }

        // Store the config path so we can persist deletions later
        self.config_path = Some(
            std::fs::canonicalize(path)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| path.to_string()),
        );

        // Prefer alerts from the main config; fall back to alerts.yaml in the same dir
        let alert_cfg = config.alerts.or_else(|| {
            let alerts_path = std::path::Path::new(path)
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("alerts.yaml");
            std::fs::read_to_string(&alerts_path)
                .ok()
                .and_then(|data| parse_alert_config(&data).ok())
        });

        // Always store alert_config (for save_config), but only activate if enabled
        if let Some(alert_cfg) = alert_cfg {
            self.alert_config = Some(alert_cfg.clone());
            if alert_cfg.enabled {
                let (engine, rx) = AlertEngine::new(alert_cfg.clone());
                spawn_alert_dispatcher(alert_cfg, rx, self.dynamic_slack.clone());
                self.alert_engine = Some(engine);
            }
        }
        Ok(())
    }

    /// Load only alert configuration from a separate file (e.g. alerts.yaml)
    pub fn load_alerts_config(&mut self, path: &str) -> Result<()> {
        let data = std::fs::read_to_string(path)?;
        let alert_cfg: AlertConfig = parse_alert_config(&data)?;
        if alert_cfg.enabled {
            let (engine, rx) = AlertEngine::new(alert_cfg.clone());
            spawn_alert_dispatcher(alert_cfg.clone(), rx, self.dynamic_slack.clone());
            self.alert_engine = Some(engine);
            self.alert_config = Some(alert_cfg);
        }
        Ok(())
    }

    pub fn add_stream(&mut self, url: &str) {
        let name = self.derive_name(url);
        self.add_stream_with_name(url, &name);
    }

    /// Add a stream with an explicit name and immediately start monitoring it.
    /// Used by the HTTP API to hot-add streams at runtime.
    pub async fn add_and_start_monitor(&mut self, url: &str, name: &str) {
        self.add_stream_with_name(url, name);
        let stream = self.streams.last().unwrap();
        let id = stream.id;
        let url = stream.url.clone();
        let protocol = stream.protocol;
        let interval = self.interval_ms;

        if self.demo_mode {
            let handle = StreamMonitor::spawn(id, url, protocol, interval, true);
            self.monitors.push(handle);
        } else if protocol == StreamProtocol::Rtsp {
            let handle = StreamMonitor::spawn(id, url, protocol, interval, false);
            self.monitors.push(handle);
        }
        // RTP streams added at runtime cannot be added to the batch receiver
        // without a restart. Leave the stream as UNKNOWN — no simulation.
        else {
            self.log(format!(
                "RTP stream '{}' registered (restart required for batch RTP monitoring to activate)",
                name
            ));
        }
    }

    fn add_stream_with_name(&mut self, url: &str, name: &str) {
        let protocol = if url.starts_with("rtp://") {
            StreamProtocol::Rtp
        } else {
            StreamProtocol::Rtsp
        };

        let entry = StreamEntry {
            id: self.next_id,
            url: url.to_string(),
            name: name.to_string(),
            protocol,
            health: StreamHealth::Unknown,
            metrics: StreamMetrics::default(),
            active: true,
        };

        self.next_id += 1;
        self.log(format!("Added stream: {} ({})", name, url));
        self.streams.push(entry);
        self.refresh_stats_view();
    }

    fn derive_name(&self, url: &str) -> String {
        // Build a unique name from IP + path segments (e.g. "192.0.2.10-c6-s1-live")
        let cleaned = url
            .trim_start_matches("rtsp://")
            .trim_start_matches("rtp://");
        if let Some(host) = cleaned.split('/').next() {
            let ip = host.split(':').next().unwrap_or(host);
            let path_segments: Vec<&str> = cleaned[host.len()..]
                .split('/')
                .filter(|s| !s.is_empty() && *s != "unicast")
                .collect();
            if path_segments.is_empty() {
                ip.to_string()
            } else {
                format!("{}-{}", ip, path_segments.join("-"))
            }
        } else {
            format!("stream-{}", self.next_id)
        }
    }

    pub fn log(&mut self, msg: String) {
        self.log_at(Local::now(), msg);
    }

    fn log_at(&mut self, ts: DateTime<Local>, msg: String) {
        if self.logs.len() >= 500 {
            self.logs.pop_front();
        }
        self.logs
            .push_back(format!("[{}] {msg}", ts.format("%H:%M:%S")));
    }

    pub async fn start_monitoring(&mut self) {
        if self.demo_mode {
            // Demo mode: use simulated metrics for all streams
            self.log("Starting in DEMO mode (simulated metrics)".to_string());
            for stream in &self.streams {
                let handle = StreamMonitor::spawn(
                    stream.id,
                    stream.url.clone(),
                    stream.protocol,
                    self.interval_ms,
                    true,
                );
                self.monitors.push(handle);
            }
            return;
        }

        // Check for capture mode (pcap-based monitoring)
        #[cfg(feature = "pcap-capture")]
        if let Some(interface) = self.capture_interface.clone() {
            self.log(format!(
                "Starting in CAPTURE mode (pcap on interface: {})",
                interface
            ));

            // Build capture endpoints from streams
            let endpoints: Vec<StreamEndpoint> = self
                .streams
                .iter()
                .filter_map(|s| CaptureMonitor::parse_endpoint(s.id, &s.name, &s.url))
                .collect();

            if endpoints.is_empty() {
                self.log("No valid endpoints for capture".to_string());
                return;
            }

            self.log(format!(
                "Capturing {} streams via pcap (RTSP ports learned dynamically)",
                endpoints.len()
            ));

            let (monitor, metrics) = CaptureMonitor::new(interface, endpoints);
            self.capture_metrics = Some(metrics);
            self.capture_thread = Some(monitor.spawn());
            return;
        }

        // Production mode: socket-based monitoring (RTP only, RTSP falls back to simulation)
        self.log("Starting in PRODUCTION mode (socket-based)".to_string());

        // Collect stream info first to avoid borrow conflicts
        let stream_info: Vec<_> = self
            .streams
            .iter()
            .map(|s| (s.id, s.url.clone(), s.name.clone(), s.protocol))
            .collect();

        let interval = self.interval_ms;
        let mut rtp_endpoints = Vec::new();
        let mut logs = Vec::new();
        let mut new_monitors = Vec::new();

        for (id, url, name, protocol) in stream_info {
            match protocol {
                StreamProtocol::Rtp => {
                    if let Some(ep) = RtpEndpoint::parse(id, &url) {
                        rtp_endpoints.push(ep);
                        logs.push(format!("RTP stream {} ready for capture", name));
                    } else {
                        logs.push(format!("Failed to parse RTP URL: {}", url));
                    }
                }
                StreamProtocol::Rtsp => {
                    logs.push(format!("RTSP stream {} monitoring via active probe", name));
                    let handle = StreamMonitor::spawn(id, url, protocol, interval, false);
                    new_monitors.push(handle);
                }
            }
        }

        // Apply collected logs and monitors
        for msg in logs {
            self.log(msg);
        }
        self.monitors.extend(new_monitors);

        // Start batch receiver for RTP streams
        if !rtp_endpoints.is_empty() {
            self.log(format!(
                "Starting batch RTP receiver for {} streams",
                rtp_endpoints.len()
            ));
            let (receiver, metrics) = BatchReceiver::new(rtp_endpoints);
            self.batch_metrics = Some(metrics);
            self.batch_thread = Some(receiver.spawn());
        }
    }

    #[allow(clippy::type_complexity)]
    pub async fn update_metrics(&mut self) {
        if self.paused {
            return;
        }
        self.tick_count += 1;

        // Collect snapshots from monitors first to avoid borrow issues
        let mut snapshots: Vec<(usize, f64, f64, f64, f64, f64, u64, u64, u64)> = Vec::new();

        // Collect from per-stream monitors (demo mode or RTSP in production)
        for monitor in &mut self.monitors {
            if let Ok(snapshot) = monitor.rx.try_recv() {
                snapshots.push((
                    snapshot.stream_id,
                    snapshot.bitrate_kbps,
                    snapshot.packet_loss_pct,
                    snapshot.jitter_ms,
                    snapshot.latency_ms,
                    snapshot.fps,
                    snapshot.packets_received,
                    snapshot.packets_lost,
                    snapshot.uptime_secs,
                ));
            }
        }

        // Collect from batch receiver (RTP in socket-based production mode)
        if let Some(ref batch_metrics) = self.batch_metrics
            && let Ok(map) = batch_metrics.lock()
        {
            for (stream_id, bm) in map.iter() {
                snapshots.push((
                    *stream_id,
                    bm.bitrate_kbps,
                    bm.packet_loss_pct,
                    bm.jitter_ms,
                    0.0, // latency not available from batch
                    0.0, // fps not available from batch (would need video parsing)
                    bm.packets_received,
                    bm.packets_lost,
                    0, // uptime tracked differently
                ));
            }
        }

        // Collect from capture monitor (pcap-based capture mode)
        #[cfg(feature = "pcap-capture")]
        if let Some(ref capture_metrics) = self.capture_metrics {
            if let Ok(map) = capture_metrics.lock() {
                for (stream_id, cm) in map.iter() {
                    snapshots.push((
                        *stream_id,
                        cm.bitrate_kbps,
                        cm.packet_loss_pct,
                        cm.jitter_ms,
                        0.0, // latency not available
                        0.0, // fps not available
                        cm.packets_received,
                        cm.packets_lost,
                        0, // uptime tracked differently
                    ));
                }
            }
        }

        // Now apply all collected snapshots
        let updated_ids: std::collections::HashSet<usize> =
            snapshots.iter().map(|(id, ..)| *id).collect();

        for (stream_id, bitrate, loss, jitter, latency, fps, pkts_recv, pkts_lost, uptime) in
            snapshots
        {
            self.apply_metrics_snapshot(
                stream_id, bitrate, loss, jitter, latency, fps, pkts_recv, pkts_lost, uptime,
            );
        }

        // Mark streams as Down if no metrics received within timeout.
        // RTSP probes fire every 5 s and can take up to ~8 s (2 s per TCP/read
        // step × 4 steps with Digest auth).  Use 30 s so a slow-but-alive probe
        // does not trigger a false Down → HEALTHY flap.
        let stale_threshold = chrono::Duration::seconds(30);
        let now = Local::now();
        let stale_events: Vec<(usize, i64)> = self
            .streams
            .iter()
            .filter_map(|stream| {
                if updated_ids.contains(&stream.id) {
                    return None;
                }
                let elapsed = now - stream.metrics.last_update;
                (elapsed > stale_threshold && stream.health != StreamHealth::Down)
                    .then_some((stream.id, elapsed.num_seconds()))
            })
            .collect();

        for (stream_id, elapsed_secs) in stale_events {
            self.set_stream_health(
                stream_id,
                StreamHealth::Down,
                format!("(no data for {elapsed_secs}s)"),
                now,
            );
        }

        if self.stats_dirty {
            self.refresh_stats_view();
        }

        // Evaluate alerts for all streams
        if self.alert_engine.is_some() {
            let streams: Vec<_> = self.streams.clone();
            if let Some(ref mut engine) = self.alert_engine {
                for stream in &streams {
                    engine.evaluate(stream);
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_metrics_snapshot(
        &mut self,
        stream_id: usize,
        bitrate_kbps: f64,
        packet_loss_pct: f64,
        jitter_ms: f64,
        latency_ms: f64,
        fps: f64,
        packets_received: u64,
        packets_lost: u64,
        uptime_secs: u64,
    ) {
        let Some(index) = self
            .streams
            .iter()
            .position(|stream| stream.id == stream_id)
        else {
            return;
        };

        let (new_health, detail, now) = {
            let stream = &mut self.streams[index];
            stream.metrics.bitrate_kbps = bitrate_kbps;
            stream.metrics.packet_loss_pct = packet_loss_pct;
            stream.metrics.jitter_ms = jitter_ms;
            stream.metrics.latency_ms = latency_ms;
            stream.metrics.fps = fps;
            stream.metrics.packets_received = packets_received;
            stream.metrics.packets_lost = packets_lost;
            stream.metrics.uptime_secs = uptime_secs;
            stream.metrics.last_update = Local::now();
            stream.metrics.push_history();

            let new_health = if packet_loss_pct > 10.0 || bitrate_kbps < 10.0 {
                StreamHealth::Down
            } else if packet_loss_pct > 2.0 || jitter_ms > 50.0 {
                // FPS is intentionally excluded: sub-streams may legitimately
                // run at low frame rates and should not trigger Degraded.
                // Health is determined by bitrate, loss, and jitter only.
                StreamHealth::Degraded
            } else {
                StreamHealth::Healthy
            };

            (
                new_health,
                format!("({})", stream.url),
                stream.metrics.last_update,
            )
        };

        self.set_stream_health(stream_id, new_health, detail, now);
    }

    pub fn next_stream(&mut self) {
        if !self.streams.is_empty() {
            self.selected = (self.selected + 1) % self.streams.len();
            self.refresh_stats_view();
        }
    }

    pub fn previous_stream(&mut self) {
        if !self.streams.is_empty() {
            self.selected = self
                .selected
                .checked_sub(1)
                .unwrap_or(self.streams.len() - 1);
            self.refresh_stats_view();
        }
    }

    pub fn next_tab(&mut self) {
        self.tab = match self.tab {
            AppTab::Dashboard => AppTab::Overview,
            AppTab::Overview => AppTab::Detail,
            AppTab::Detail => AppTab::Logs,
            AppTab::Logs => AppTab::Stats,
            AppTab::Stats => AppTab::Dashboard,
        };
    }

    pub fn prev_tab(&mut self) {
        self.tab = match self.tab {
            AppTab::Dashboard => AppTab::Stats,
            AppTab::Overview => AppTab::Dashboard,
            AppTab::Detail => AppTab::Overview,
            AppTab::Logs => AppTab::Detail,
            AppTab::Stats => AppTab::Logs,
        };
    }

    pub fn toggle_add_dialog(&mut self) {
        self.show_add_dialog = !self.show_add_dialog;
        if self.show_add_dialog {
            self.input_buffer.clear();
        }
    }

    /// Persist current in-memory streams back to the config file on disk.
    /// Polled streams (added via RTPulse API) are excluded — they are
    /// re-fetched from the API on the next startup and must not be frozen
    /// into the static config file.
    fn save_config(&self) {
        let Some(ref path) = self.config_path else {
            return; // no config file loaded — nothing to persist
        };
        let config = StreamConfig {
            streams: self
                .streams
                .iter()
                .filter(|s| !self.polled_urls.contains(&s.url))
                .map(|s| StreamUrl {
                    url: s.url.clone(),
                    name: Some(s.name.clone()),
                })
                .collect(),
            alerts: self.alert_config.clone(),
        };
        match serde_yaml::to_string(&config) {
            Ok(yaml) => {
                if let Err(e) = std::fs::write(path, yaml) {
                    // Log to stderr — self.log() needs &mut self
                    eprintln!("[rtpulse] Failed to save config to {path}: {e}");
                }
            }
            Err(e) => eprintln!("[rtpulse] Failed to serialize config: {e}"),
        }
    }

    /// Remove a stream by its numeric ID (called from the HTTP API).
    pub fn remove_stream_by_id(&mut self, id: usize) {
        if let Some(pos) = self.streams.iter().position(|s| s.id == id) {
            let name = self.streams[pos].name.clone();
            let url  = self.streams[pos].url.clone();
            self.streams.remove(pos);
            self.monitors.retain(|m| m.stream_id != id);
            // Clean up polled tracking so the poller doesn't try to remove
            // a stream that's already gone.
            self.polled_urls.remove(&url);
            if self.selected >= self.streams.len() && self.selected > 0 {
                self.selected -= 1;
            }
            self.log(format!("Removed stream via API: {name}"));
            self.refresh_stats_view();
            // Persist the deletion so the stream doesn't come back on restart
            self.save_config();
        }
    }

    /// Add a stream that originated from RTPulse API polling.
    /// Registers the URL in `polled_urls` FIRST so the poller can always
    /// remove it later — even if the stream was already added via the HTTP
    /// API (register:true) before the first poll fired.
    pub async fn add_polled_stream(&mut self, url: &str, name: &str) {
        // Always mark as polled so removal works regardless of how it was added.
        self.polled_urls.insert(url.to_string());
        if self.streams.iter().any(|s| s.url == url) {
            return; // already present — only needed the polled_urls update
        }
        self.add_and_start_monitor(url, name).await;
    }

    /// Rename a polled stream in-place (same URL, different name from DB).
    /// Does not reset metrics or restart the monitor — only updates the display name.
    pub fn rename_polled_stream_by_url(&mut self, url: &str, new_name: &str) {
        if let Some(stream) = self.streams.iter_mut().find(|s| s.url == url) {
            let old_name = std::mem::replace(&mut stream.name, new_name.to_string());
            if old_name != new_name {
                self.logs.push_back(format!(
                    "Poller: renamed '{}' → '{}'",
                    old_name, new_name
                ));
                if self.logs.len() > 500 {
                    self.logs.pop_front();
                }
            }
        }
    }

    /// Remove a stream that was previously added via API polling.
    /// Only removes streams whose URL is in `polled_urls`; static
    /// streams from the config file are left untouched.
    pub fn remove_polled_stream_by_url(&mut self, url: &str) {
        if !self.polled_urls.contains(url) {
            return; // not a polled stream — do not touch
        }
        if let Some(pos) = self.streams.iter().position(|s| s.url == url) {
            let id = self.streams[pos].id;
            let name = self.streams[pos].name.clone();
            self.streams.remove(pos);
            self.monitors.retain(|m| m.stream_id != id);
            self.polled_urls.remove(url);
            if self.selected >= self.streams.len() && self.selected > 0 {
                self.selected -= 1;
            }
            self.log(format!("Poller: removed stream '{name}' (no longer in API)"));
            self.refresh_stats_view();
        }
    }

    pub fn delete_selected_stream(&mut self) {
        if !self.streams.is_empty() {
            let name = self.streams[self.selected].name.clone();
            let url  = self.streams[self.selected].url.clone();
            let id   = self.streams[self.selected].id;
            self.streams.remove(self.selected);
            self.monitors.retain(|m| m.stream_id != id);
            self.polled_urls.remove(&url);
            self.log(format!("Removed stream: {name}"));
            if self.selected >= self.streams.len() && self.selected > 0 {
                self.selected -= 1;
            }
            self.refresh_stats_view();
        }
    }

    pub async fn restart_selected_stream(&mut self) {
        if let Some(stream) = self.streams.get_mut(self.selected) {
            stream.health = StreamHealth::Unknown;
            stream.metrics = StreamMetrics::default();
            let id = stream.id;
            let url = stream.url.clone();
            let protocol = stream.protocol;

            // Remove old monitor
            self.monitors.retain(|m| m.stream_id != id);

            // Spawn new one
            let handle =
                StreamMonitor::spawn(id, url.clone(), protocol, self.interval_ms, self.demo_mode);
            self.monitors.push(handle);

            self.log(format!("Restarted monitoring: {url}"));
            self.refresh_stats_view();
        }
    }

    pub async fn confirm_add_stream(&mut self) {
        if !self.input_buffer.is_empty() {
            let url = self.input_buffer.clone();
            self.add_stream(&url);
            let stream = self.streams.last().unwrap();
            let handle = StreamMonitor::spawn(
                stream.id,
                stream.url.clone(),
                stream.protocol,
                self.interval_ms,
                self.demo_mode,
            );
            self.monitors.push(handle);
            self.show_add_dialog = false;
            self.input_buffer.clear();
        }
    }

    /// Export stats to an xlsx file in the current working directory.
    /// Result (filename or error) is written to the app log.
    pub fn export_stats(&mut self) {
        let result = match &self.stats_store {
            None => Err(anyhow::anyhow!("Stats DB unavailable")),
            Some(store) => crate::export::export_xlsx(&self.stats_view, &self.streams, store),
        };
        match result {
            Ok(filename) => self.log(format!("✓ Exported: {filename}")),
            Err(err) => self.log(format!("✗ Export failed: {err}")),
        }
    }

    pub fn toggle_pause(&mut self) {
        self.paused = !self.paused;
        self.log(format!(
            "Monitoring {}",
            if self.paused { "PAUSED" } else { "RESUMED" }
        ));
    }

    pub fn toggle_sort(&mut self) {
        self.sort_mode = self.sort_mode.next();
        self.log(format!("Sort by: {}", self.sort_mode.label()));
    }

    pub fn cycle_stats_filter(&mut self) {
        self.stats_filter = self.stats_filter.next();
        self.stats_dirty = true;
        self.refresh_stats_view();
    }

    /// Update the shared API snapshot read by the HTTP server.
    pub fn update_api_state(&self, shared: &SharedApiState) {
        use chrono::Local;
        let (healthy, degraded, down, unknown) = self.summary();
        let agg = self.aggregate_metrics();
        let snapshot = crate::api::ApiSnapshot {
            info: crate::api::ApiInfo {
                version: env!("CARGO_PKG_VERSION").to_string(),
                stream_count: self.streams.len(),
                captured_at: Local::now().timestamp(),
            },
            streams: self.streams.iter().map(stream_to_api).collect(),
            aggregate: aggregate_to_api(&agg, healthy, degraded, down, unknown),
            logs: self.logs.clone(),
            stats: stats_view_to_api(&self.stats_view, self.stats_filter),
        };
        if let Ok(mut guard) = shared.write() {
            *guard = snapshot;
        }
    }

    pub fn sorted_stream_indices(&self) -> Vec<usize> {
        let mut indices: Vec<usize> = (0..self.streams.len()).collect();
        match self.sort_mode {
            SortMode::ById => {} // already sorted
            SortMode::ByHealth => indices.sort_by_key(|&i| match self.streams[i].health {
                StreamHealth::Down => 0,
                StreamHealth::Degraded => 1,
                StreamHealth::Unknown => 2,
                StreamHealth::Healthy => 3,
            }),
            SortMode::ByBitrate => {
                indices.sort_by(|&a, &b| {
                    self.streams[b]
                        .metrics
                        .bitrate_kbps
                        .partial_cmp(&self.streams[a].metrics.bitrate_kbps)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
            SortMode::ByLoss => {
                indices.sort_by(|&a, &b| {
                    self.streams[b]
                        .metrics
                        .packet_loss_pct
                        .partial_cmp(&self.streams[a].metrics.packet_loss_pct)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
        }
        indices
    }

    pub fn selected_stream(&self) -> Option<&StreamEntry> {
        self.streams.get(self.selected)
    }

    pub fn summary(&self) -> (usize, usize, usize, usize) {
        let healthy = self
            .streams
            .iter()
            .filter(|s| s.health == StreamHealth::Healthy)
            .count();
        let degraded = self
            .streams
            .iter()
            .filter(|s| s.health == StreamHealth::Degraded)
            .count();
        let down = self
            .streams
            .iter()
            .filter(|s| s.health == StreamHealth::Down)
            .count();
        let unknown = self
            .streams
            .iter()
            .filter(|s| s.health == StreamHealth::Unknown)
            .count();
        (healthy, degraded, down, unknown)
    }

    /// Aggregate metrics across all streams
    pub fn aggregate_metrics(&self) -> AggregateMetrics {
        if self.streams.is_empty() {
            return AggregateMetrics::default();
        }
        let n = self.streams.len() as f64;
        let total_bitrate: f64 = self.streams.iter().map(|s| s.metrics.bitrate_kbps).sum();
        let avg_loss: f64 = self
            .streams
            .iter()
            .map(|s| s.metrics.packet_loss_pct)
            .sum::<f64>()
            / n;
        let avg_jitter: f64 = self
            .streams
            .iter()
            .map(|s| s.metrics.jitter_ms)
            .sum::<f64>()
            / n;
        let max_loss = self
            .streams
            .iter()
            .map(|s| s.metrics.packet_loss_pct)
            .fold(0.0f64, f64::max);
        let max_jitter = self
            .streams
            .iter()
            .map(|s| s.metrics.jitter_ms)
            .fold(0.0f64, f64::max);
        let total_pkts_recv: u64 = self
            .streams
            .iter()
            .map(|s| s.metrics.packets_received)
            .sum();
        let total_pkts_lost: u64 = self.streams.iter().map(|s| s.metrics.packets_lost).sum();

        AggregateMetrics {
            total_streams: self.streams.len(),
            total_bitrate_kbps: total_bitrate,
            avg_loss_pct: avg_loss,
            avg_jitter_ms: avg_jitter,
            max_loss_pct: max_loss,
            max_jitter_ms: max_jitter,
            total_pkts_recv,
            total_pkts_lost,
        }
    }

    /// Return streams that are not healthy (for dashboard problem list)
    pub fn problem_streams(&self) -> Vec<&StreamEntry> {
        self.streams
            .iter()
            .filter(|s| s.health != StreamHealth::Healthy && s.health != StreamHealth::Unknown)
            .collect()
    }

    /// Spawn a background discover task and merge results into running streams.
    /// Only available in pcap-capture builds. Duration in seconds.
    #[cfg(feature = "pcap-capture")]
    pub fn start_live_discover(&mut self, duration_secs: u64) {
        use crate::discover::Discoverer;
        use std::thread;

        let Some(ref iface) = self.capture_interface.clone() else {
            self.log("Live discover requires -I <interface>".to_string());
            return;
        };
        if self.discovering {
            self.log("Discover already running".to_string());
            return;
        }

        self.discovering = true;
        let iface = iface.clone();
        self.log(format!(
            "Starting live discover on {} for {}s…",
            iface, duration_secs
        ));

        // Use a shared channel to send discovered URLs back to the main thread
        let (tx, rx) = std::sync::mpsc::channel::<Vec<String>>();

        thread::spawn(move || {
            let mut disc = Discoverer::new();
            let _ = disc.run(&iface, duration_secs, &[554, 8554]);
            let urls: Vec<String> = disc.streams().iter().map(|s| s.url.clone()).collect();
            let _ = tx.send(urls);
        });

        // Store receiver so update_metrics can poll it
        self._discover_rx = Some(rx);
    }

    /// Poll discover results and merge into streams (called from update_metrics).
    #[cfg(feature = "pcap-capture")]
    pub fn poll_discover_results(&mut self) {
        let Some(ref rx) = self._discover_rx else {
            return;
        };
        if let Ok(urls) = rx.try_recv() {
            self.discovering = false;
            let mut added = 0usize;
            for url in &urls {
                if !self.streams.iter().any(|s| s.url == *url) {
                    self.add_stream(url);
                    added += 1;
                }
            }
            self.log(format!(
                "Discover complete: {} total, {} new streams added",
                urls.len(),
                added
            ));
            self._discover_rx = None;
            // Restart monitoring to include new streams
            // (caller should invoke start_monitoring)
        }
    }

    fn set_stream_health(
        &mut self,
        stream_id: usize,
        new_health: StreamHealth,
        detail: String,
        happened_at: DateTime<Local>,
    ) {
        let Some(index) = self.streams.iter().position(|s| s.id == stream_id) else {
            return;
        };

        let (old_health, name, url) = {
            let stream = &mut self.streams[index];
            let old_health = stream.health;
            if old_health == new_health {
                return;
            }
            stream.health = new_health;
            (old_health, stream.name.clone(), stream.url.clone())
        };

        self.log_at(
            happened_at,
            format!("{name} → {} {detail}", new_health.label()),
        );

        if let Some(kind) = connection_event_kind(old_health, new_health)
            && let Some(store) = &self.stats_store
        {
            match store.record_event(&crate::stats::ConnectionEvent {
                stream_id,
                stream_name: &name,
                stream_url: &url,
                kind,
                from_health: old_health,
                to_health: new_health,
                happened_at_epoch: happened_at.timestamp(),
            }) {
                Ok(()) => self.stats_dirty = true,
                Err(err) => self.log(format!("Failed to record stats event for {name}: {err}")),
            }
        }
    }

    fn refresh_stats_view(&mut self) {
        self.stats_dirty = false;
        let filter = self.stats_filter;
        let next_view = match self.stats_store.as_ref() {
            Some(store) => match store.read_snapshot(Local::now(), filter) {
                Ok(snapshot) => self.merge_stats_snapshot(snapshot),
                Err(err) => StatsView {
                    error: Some(format!("Stats query failed: {err}")),
                    ..StatsView::default()
                },
            },
            None => StatsView {
                error: Some(format!("Stats DB unavailable ({STATS_DB_PATH})")),
                ..StatsView::default()
            },
        };
        self.stats_view = next_view;
    }

    fn merge_stats_snapshot(&self, snapshot: StatsSnapshot) -> StatsView {
        let StatsSnapshot {
            summary,
            stream_counts,
            daily_trend,
            weekly_trend,
            monthly_trend,
            filter_trend,
            event_log,
            error,
        } = snapshot;

        StatsView {
            summary,
            filter_trend,
            daily_trend,
            weekly_trend,
            monthly_trend,
            rows: self.build_stats_rows(stream_counts),
            event_log,
            error,
        }
    }

    fn build_stats_rows(&self, counts: Vec<StreamEventCounts>) -> Vec<StatsRow> {
        let counts_by_stream: HashMap<usize, StreamEventCounts> = counts
            .into_iter()
            .map(|c| (c.stream_id, c))
            .collect();

        let mut rows: Vec<StatsRow> = self
            .streams
            .iter()
            .map(|stream| {
                let c = counts_by_stream.get(&stream.id);
                StatsRow {
                    stream_id: stream.id,
                    stream_name: stream.name.clone(),
                    down_count: c.map(|c| c.down_count).unwrap_or(0),
                    warn_count: c.map(|c| c.warn_count).unwrap_or(0),
                    reconnect_count: c.map(|c| c.reconnect_count).unwrap_or(0),
                    last_event_epoch: c.and_then(|c| c.last_event_epoch),
                }
            })
            .collect();

        rows.sort_by(|a, b| {
            b.down_count
                .cmp(&a.down_count)
                .then_with(|| b.warn_count.cmp(&a.warn_count))
                .then_with(|| b.last_event_epoch.cmp(&a.last_event_epoch))
                .then_with(|| a.stream_name.cmp(&b.stream_name))
        });
        rows
    }
}

#[derive(Debug, Clone, Default)]
pub struct AggregateMetrics {
    #[allow(dead_code)]
    pub total_streams: usize,
    pub total_bitrate_kbps: f64,
    pub avg_loss_pct: f64,
    pub avg_jitter_ms: f64,
    pub max_loss_pct: f64,
    pub max_jitter_ms: f64,
    pub total_pkts_recv: u64,
    pub total_pkts_lost: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::{ConnectionEventKind, StreamEventCounts, connection_event_kind};

    #[test]
    fn stats_rows_include_zero_event_streams_and_sort_by_downs() {
        let app = App {
            streams: vec![
                StreamEntry {
                    id: 1,
                    url: "rtsp://cam-a/live".to_string(),
                    name: "cam-a".to_string(),
                    protocol: StreamProtocol::Rtsp,
                    health: StreamHealth::Healthy,
                    metrics: StreamMetrics::default(),
                    active: true,
                },
                StreamEntry {
                    id: 2,
                    url: "rtsp://cam-b/live".to_string(),
                    name: "cam-b".to_string(),
                    protocol: StreamProtocol::Rtsp,
                    health: StreamHealth::Healthy,
                    metrics: StreamMetrics::default(),
                    active: true,
                },
            ],
            selected: 0,
            tab: AppTab::Dashboard,
            sort_mode: SortMode::ById,
            paused: false,
            show_add_dialog: false,
            input_buffer: String::new(),
            logs: VecDeque::new(),
            stats_view: StatsView::default(),
            stats_filter: StatsFilter::default(),
            tick_count: 0,
            interval_ms: 1000,
            demo_mode: true,
            next_id: 2,
            monitors: Vec::new(),
            stats_store: None,
            stats_dirty: true,
            batch_metrics: None,
            batch_thread: None,
            alert_engine: None,
            alert_config: None,
            config_path: None,
            dynamic_slack: std::sync::Arc::new(std::sync::RwLock::new(None)),
            polled_urls: HashSet::new(),
            #[cfg(feature = "pcap-capture")]
            capture_interface: None,
            #[cfg(feature = "pcap-capture")]
            capture_metrics: None,
            #[cfg(feature = "pcap-capture")]
            capture_thread: None,
            #[cfg(feature = "pcap-capture")]
            discovering: false,
            #[cfg(feature = "pcap-capture")]
            _discover_rx: None,
        };

        let rows = app.build_stats_rows(vec![
            StreamEventCounts {
                stream_id: 1,
                down_count: 1,
                warn_count: 0,
                reconnect_count: 1,
                last_event_epoch: Some(10),
            },
            StreamEventCounts {
                stream_id: 2,
                down_count: 3,
                warn_count: 2,
                reconnect_count: 3,
                last_event_epoch: Some(20),
            },
        ]);

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].stream_id, 2);
        assert_eq!(rows[0].down_count, 3);
        assert_eq!(rows[0].warn_count, 2);
        assert_eq!(rows[1].stream_id, 1);
        assert_eq!(rows[1].down_count, 1);
    }

    #[test]
    fn connection_transition_rules_match_stats_expectations() {
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
    }
}
