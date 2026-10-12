//! Background task that polls the RTPulse web API every 30 s
//! and syncs stream additions / removals / renames into the running app.
//!
//! Endpoint: GET {api_url}/api/cameras/{customer_id}/config
//! Response: [{"name": "카메라1 (메인)", "url": "rtsp://..."}, ...]
//!
//! The poller keeps its own copy of the last-known API state and
//! computes a diff on every tick. Only deltas are pushed into the
//! queues so the main loop does minimal work per frame.

use std::sync::{Arc, Mutex};
use tokio::time::{Duration, MissedTickBehavior, interval};

/// A stream entry returned by the RTPulse config endpoint.
#[derive(serde::Deserialize, Clone)]
struct ApiStream {
    name: String,
    url: String,
}

// ── Public queue types ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PollAdd {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct PollRename {
    pub url: String,
    pub new_name: String,
}

/// Streams to add — produced by the poller, consumed by `run_app`.
pub type PollAddQueue = Arc<Mutex<Vec<PollAdd>>>;

/// Stream URLs to remove — produced by the poller, consumed by `run_app`.
pub type PollRemoveQueue = Arc<Mutex<Vec<String>>>;

/// Streams whose name changed (same URL, different name).
pub type PollRenameQueue = Arc<Mutex<Vec<PollRename>>>;

// ── Public API ────────────────────────────────────────────────────────────────

/// Spawn a background tokio task that polls the RTPulse config endpoint
/// every 30 seconds and pushes stream-add / stream-remove / stream-rename
/// commands into the supplied queues.
///
/// The first poll fires immediately (Tokio `interval` fires at t = 0).
/// Errors are logged as warnings; the poller retries on the next tick.
pub fn spawn_poller(
    api_url: String,
    customer_id: String,
    add_queue: PollAddQueue,
    remove_queue: PollRemoveQueue,
    rename_queue: PollRenameQueue,
) {
    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Poller: failed to build HTTP client: {e}");
                return;
            }
        };

        let endpoint = format!(
            "{}/api/cameras/{}/config",
            api_url.trim_end_matches('/'),
            customer_id,
        );

        tracing::info!("Poller: syncing streams from {endpoint} every 30 s");

        let mut last_state: Vec<ApiStream> = Vec::new();
        let mut ticker = interval(Duration::from_secs(30));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;

            match client.get(&endpoint).send().await {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<Vec<ApiStream>>().await {
                        Ok(current) => {
                            let added   = diff_added(&last_state, &current);
                            let removed = diff_removed(&last_state, &current);
                            let renamed = diff_renamed(&last_state, &current);

                            if !added.is_empty() || !removed.is_empty() || !renamed.is_empty() {
                                tracing::info!(
                                    "Poller: +{} / -{} / ~{} streams",
                                    added.len(),
                                    removed.len(),
                                    renamed.len(),
                                );
                            }

                            if !added.is_empty() {
                                add_queue.lock().unwrap().extend(added);
                            }
                            if !removed.is_empty() {
                                remove_queue.lock().unwrap().extend(removed);
                            }
                            if !renamed.is_empty() {
                                rename_queue.lock().unwrap().extend(renamed);
                            }

                            last_state = current;
                        }
                        Err(e) => {
                            tracing::warn!("Poller: failed to parse response: {e}");
                        }
                    }
                }
                Ok(resp) => {
                    tracing::warn!("Poller: {endpoint} → HTTP {}", resp.status());
                }
                Err(e) => {
                    tracing::warn!("Poller: request failed: {e}");
                }
            }
        }
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Returns streams present in `current` but absent from `last` (by URL).
fn diff_added(last: &[ApiStream], current: &[ApiStream]) -> Vec<PollAdd> {
    let last_urls: std::collections::HashSet<&str> =
        last.iter().map(|s| s.url.as_str()).collect();

    current
        .iter()
        .filter(|s| !last_urls.contains(s.url.as_str()))
        .map(|s| PollAdd {
            name: s.name.clone(),
            url: s.url.clone(),
        })
        .collect()
}

/// Returns URLs present in `last` but absent from `current`.
fn diff_removed(last: &[ApiStream], current: &[ApiStream]) -> Vec<String> {
    let current_urls: std::collections::HashSet<&str> =
        current.iter().map(|s| s.url.as_str()).collect();

    last.iter()
        .filter(|s| !current_urls.contains(s.url.as_str()))
        .map(|s| s.url.clone())
        .collect()
}

/// Returns streams present in both `last` and `current` (same URL) but whose name changed.
fn diff_renamed(last: &[ApiStream], current: &[ApiStream]) -> Vec<PollRename> {
    let last_by_url: std::collections::HashMap<&str, &str> =
        last.iter().map(|s| (s.url.as_str(), s.name.as_str())).collect();

    current
        .iter()
        .filter(|s| {
            last_by_url
                .get(s.url.as_str())
                .map(|&old_name| old_name != s.name.as_str())
                .unwrap_or(false)
        })
        .map(|s| PollRename {
            url: s.url.clone(),
            new_name: s.name.clone(),
        })
        .collect()
}
