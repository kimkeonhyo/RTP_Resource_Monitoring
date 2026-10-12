use crate::app::{StreamEntry, StreamHealth};
use anyhow::Result;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;

/// A runtime-configurable Slack webhook URL (set via the web UI after startup).
pub type SharedSlackWebhook = Arc<RwLock<Option<String>>>;

// ─── Alert types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Alert {
    pub stream_id: usize,
    pub stream_name: String,
    pub stream_url: String,
    pub severity: AlertSeverity,
    pub message: String,
    pub timestamp: DateTime<Local>,
    pub metrics: AlertMetrics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertSeverity {
    Warning,
    Critical,
    Resolved,
}

impl AlertSeverity {
    pub fn emoji(&self) -> &str {
        match self {
            AlertSeverity::Warning => "⚠️",
            AlertSeverity::Critical => "🔴",
            AlertSeverity::Resolved => "✅",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AlertMetrics {
    pub bitrate_kbps: f64,
    pub packet_loss_pct: f64,
    pub jitter_ms: f64,
    pub fps: f64,
}

// ─── Alert rules (configurable thresholds) ──────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AlertRules {
    /// Packet loss % to trigger warning
    #[serde(default = "default_loss_warn")]
    pub loss_warn: f64,
    /// Packet loss % to trigger critical
    #[serde(default = "default_loss_crit")]
    pub loss_crit: f64,
    /// Jitter ms to trigger warning
    #[serde(default = "default_jitter_warn")]
    pub jitter_warn: f64,
    /// Jitter ms to trigger critical
    #[serde(default = "default_jitter_crit")]
    pub jitter_crit: f64,
    /// Minimum bitrate kbps (below = critical)
    #[serde(default = "default_min_bitrate")]
    pub min_bitrate: f64,
    /// Minimum FPS (below = warning)
    #[serde(default = "default_min_fps")]
    pub min_fps: f64,
    /// Cooldown between repeated alerts for same stream (seconds)
    #[serde(default = "default_cooldown_secs")]
    pub cooldown_secs: u64,
}

impl Default for AlertRules {
    fn default() -> Self {
        Self {
            loss_warn: 2.0,
            loss_crit: 10.0,
            jitter_warn: 50.0,
            jitter_crit: 100.0,
            min_bitrate: 10.0,
            min_fps: 15.0,
            cooldown_secs: 60,
        }
    }
}

// ─── Alert sink configurations ──────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WebhookConfig {
    pub url: String,
    /// Optional custom headers (e.g., auth tokens)
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Only send alerts of this severity or higher
    #[serde(default = "default_min_severity")]
    pub min_severity: String,
}

fn default_loss_warn() -> f64 {
    2.0
}
fn default_loss_crit() -> f64 {
    10.0
}
fn default_jitter_warn() -> f64 {
    50.0
}
fn default_jitter_crit() -> f64 {
    100.0
}
fn default_min_bitrate() -> f64 {
    10.0
}
fn default_min_fps() -> f64 {
    15.0
}
fn default_cooldown_secs() -> u64 {
    60
}

fn default_min_severity() -> String {
    "warning".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SlackConfig {
    /// Slack incoming webhook URL
    pub webhook_url: String,
    /// Channel override (optional, uses webhook default if empty)
    pub channel: Option<String>,
    /// Username override
    #[serde(default = "default_slack_username")]
    pub username: String,
}

fn default_slack_username() -> String {
    "rtpulse".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AlertConfig {
    #[serde(default)]
    pub rules: AlertRules,
    #[serde(default)]
    pub webhooks: Vec<WebhookConfig>,
    #[serde(default)]
    pub slack: Vec<SlackConfig>,
    /// Enable alerting
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AlertConfig {
    fn default() -> Self {
        Self {
            rules: AlertRules::default(),
            webhooks: Vec::new(),
            slack: Vec::new(),
            enabled: true,
        }
    }
}

// ─── Alert engine ───────────────────────────────────────────────────────────

pub struct AlertEngine {
    config: AlertConfig,
    /// Last alert time per stream_id to enforce cooldown
    last_alert: HashMap<usize, DateTime<Local>>,
    /// Previous health state to detect transitions
    prev_health: HashMap<usize, StreamHealth>,
    /// Channel to send alerts to the async dispatcher
    alert_tx: mpsc::UnboundedSender<Alert>,
    /// Pending alerts for the UI to display
    pub pending_alerts: Vec<Alert>,
    pub total_alerts_sent: u64,
}

impl AlertEngine {
    pub fn new(config: AlertConfig) -> (Self, mpsc::UnboundedReceiver<Alert>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Self {
                config,
                last_alert: HashMap::new(),
                prev_health: HashMap::new(),
                alert_tx: tx,
                pending_alerts: Vec::new(),
                total_alerts_sent: 0,
            },
            rx,
        )
    }

    /// Evaluate a stream and fire alerts if thresholds crossed
    pub fn evaluate(&mut self, stream: &StreamEntry) {
        if !self.config.enabled {
            return;
        }

        let prev = self.prev_health.get(&stream.id).copied();
        let current = stream.health;

        // Detect health transition
        let transition = match (prev, current) {
            (Some(old), new) if old != new => true,
            (None, _) => false, // first observation, no alert
            _ => false,
        };

        self.prev_health.insert(stream.id, current);

        if !transition {
            return;
        }

        let (severity, message) = match current {
            StreamHealth::Down => (
                AlertSeverity::Critical,
                format!(
                    "Stream DOWN — loss: {:.1}%, bitrate: {:.0} kbps",
                    stream.metrics.packet_loss_pct, stream.metrics.bitrate_kbps
                ),
            ),
            StreamHealth::Degraded => (
                AlertSeverity::Warning,
                format!(
                    "Stream degraded — loss: {:.1}%, jitter: {:.1}ms, fps: {:.1}",
                    stream.metrics.packet_loss_pct, stream.metrics.jitter_ms, stream.metrics.fps
                ),
            ),
            StreamHealth::Healthy
                if prev == Some(StreamHealth::Down) || prev == Some(StreamHealth::Degraded) =>
            {
                (
                    AlertSeverity::Resolved,
                    "Stream recovered to healthy state".to_string(),
                )
            }
            _ => return,
        };

        // Cooldown applies to warning/critical only; resolved alerts are always sent
        if severity != AlertSeverity::Resolved
            && let Some(last) = self.last_alert.get(&stream.id)
        {
            let elapsed = (Local::now() - *last).num_seconds() as u64;
            if elapsed < self.config.rules.cooldown_secs {
                return;
            }
        }

        let alert = Alert {
            stream_id: stream.id,
            stream_name: stream.name.clone(),
            stream_url: stream.url.clone(),
            severity,
            message,
            timestamp: Local::now(),
            metrics: AlertMetrics {
                bitrate_kbps: stream.metrics.bitrate_kbps,
                packet_loss_pct: stream.metrics.packet_loss_pct,
                jitter_ms: stream.metrics.jitter_ms,
                fps: stream.metrics.fps,
            },
        };

        self.last_alert.insert(stream.id, Local::now());
        self.pending_alerts.push(alert.clone());
        self.total_alerts_sent += 1;

        // Send to async dispatcher (non-blocking)
        let _ = self.alert_tx.send(alert);
    }
}

// ─── Async alert dispatcher ─────────────────────────────────────────────────

pub fn spawn_alert_dispatcher(
    config: AlertConfig,
    mut rx: mpsc::UnboundedReceiver<Alert>,
    dynamic_slack: SharedSlackWebhook,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();

        while let Some(alert) = rx.recv().await {
            // Send to all configured webhooks (from YAML)
            for wh in &config.webhooks {
                let _ = send_webhook(&client, wh, &alert).await;
            }

            // Send to all configured Slack channels (from YAML)
            for slack in &config.slack {
                let _ = send_slack(&client, slack, &alert).await;
            }

            // Send to the runtime-configured Slack webhook (from web UI)
            let dynamic_url: Option<String> = dynamic_slack.read().ok().and_then(|g| g.clone());
            if let Some(webhook_url) = dynamic_url {
                let dynamic = SlackConfig {
                    webhook_url,
                    channel: None,
                    username: "rtpulse".to_string(),
                };
                let _ = send_slack(&client, &dynamic, &alert).await;
            }
        }
    })
}

async fn send_webhook(
    client: &reqwest::Client,
    config: &WebhookConfig,
    alert: &Alert,
) -> Result<()> {
    let mut req = client.post(&config.url).json(alert);

    for (key, value) in &config.headers {
        req = req.header(key.as_str(), value.as_str());
    }

    let resp = req.send().await?;
    if !resp.status().is_success() {
        tracing::warn!("Webhook {} returned status {}", config.url, resp.status());
    }
    Ok(())
}

async fn send_slack(client: &reqwest::Client, config: &SlackConfig, alert: &Alert) -> Result<()> {
    let color = match alert.severity {
        AlertSeverity::Critical => "#e74c3c",
        AlertSeverity::Warning => "#f39c12",
        AlertSeverity::Resolved => "#2ecc71",
    };

    let payload = serde_json::json!({
        "username": config.username,
        "channel": config.channel,
        "attachments": [{
            "color": color,
            "title": format!(
                "{} {} — {}",
                alert.severity.emoji(),
                alert.stream_name,
                match alert.severity {
                    AlertSeverity::Critical => "CRITICAL",
                    AlertSeverity::Warning => "WARNING",
                    AlertSeverity::Resolved => "RESOLVED",
                }
            ),
            "text": &alert.message,
            "fields": [
                { "title": "Stream", "value": &alert.stream_url, "short": false },
                { "title": "Bitrate", "value": format!("{:.0} kbps", alert.metrics.bitrate_kbps), "short": true },
                { "title": "Packet Loss", "value": format!("{:.2}%", alert.metrics.packet_loss_pct), "short": true },
                { "title": "Jitter", "value": format!("{:.1} ms", alert.metrics.jitter_ms), "short": true },
                { "title": "FPS", "value": format!("{:.1}", alert.metrics.fps), "short": true },
            ],
            "ts": alert.timestamp.timestamp(),
        }]
    });

    let resp = client
        .post(&config.webhook_url)
        .json(&payload)
        .send()
        .await?;
    if !resp.status().is_success() {
        tracing::warn!("Slack webhook returned status {}", resp.status());
    }
    Ok(())
}
