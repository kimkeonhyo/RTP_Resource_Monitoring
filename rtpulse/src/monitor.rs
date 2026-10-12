use crate::app::StreamProtocol;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{self, Duration, timeout};

// ---------------------------------------------------------------------------
// Digest auth helpers
// ---------------------------------------------------------------------------

/// Compute RTSP Digest auth response header value
fn compute_digest_auth(
    username: &str,
    password: &str,
    realm: &str,
    nonce: &str,
    method: &str,
    uri: &str,
) -> String {
    let ha1 = format!(
        "{:x}",
        md5::compute(format!("{}:{}:{}", username, realm, password))
    );
    let ha2 = format!("{:x}", md5::compute(format!("{}:{}", method, uri)));
    let response_hash = format!("{:x}", md5::compute(format!("{}:{}:{}", ha1, nonce, ha2)));
    format!(
        r#"Digest username="{}", realm="{}", nonce="{}", uri="{}", response="{}""#,
        username, realm, nonce, uri, response_hash
    )
}

fn parse_digest_challenge(response: &str) -> Option<(String, String)> {
    let line = response
        .lines()
        .find(|l| l.to_lowercase().starts_with("www-authenticate:"))?;
    let realm = extract_quoted_param(line, "realm")?;
    let nonce = extract_quoted_param(line, "nonce")?;
    Some((realm, nonce))
}

fn extract_quoted_param(s: &str, param: &str) -> Option<String> {
    let lower = s.to_lowercase();
    let search = format!("{}=\"", param);
    let idx = lower.find(&search)?;
    let start = idx + search.len();
    let end = s[start..].find('"')? + start;
    Some(s[start..end].to_string())
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte as char);
            i += 3;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

struct RtspParsed {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
}

fn parse_rtsp_parsed(url: &str) -> Option<RtspParsed> {
    let stripped = url.strip_prefix("rtsp://")?;
    let (userinfo, hostpath) = if let Some(at) = stripped.rfind('@') {
        (Some(&stripped[..at]), &stripped[at + 1..])
    } else {
        (None, stripped)
    };
    let (username, password) = if let Some(ui) = userinfo {
        if let Some(colon) = ui.find(':') {
            (
                Some(percent_decode(&ui[..colon])),
                Some(percent_decode(&ui[colon + 1..])),
            )
        } else {
            (Some(percent_decode(ui)), None)
        }
    } else {
        (None, None)
    };
    let hostport = hostpath.split('/').next()?;
    let (host, port) = if let Some(colon) = hostport.rfind(':') {
        (
            hostport[..colon].to_string(),
            hostport[colon + 1..].parse::<u16>().unwrap_or(554),
        )
    } else {
        (hostport.to_string(), 554)
    };
    Some(RtspParsed {
        host,
        port,
        username,
        password,
    })
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

fn make_alive(stream_id: usize, prev_uptime: u64, latency_ms: f64) -> MetricsSnapshot {
    MetricsSnapshot {
        stream_id,
        bitrate_kbps: 1000.0,
        packet_loss_pct: 0.0,
        jitter_ms: 0.0,
        latency_ms,
        fps: 0.0,
        packets_received: prev_uptime + 1,
        packets_lost: 0,
        uptime_secs: prev_uptime + 1,
    }
}

fn make_dead(stream_id: usize, latency_ms: f64) -> MetricsSnapshot {
    MetricsSnapshot {
        stream_id,
        bitrate_kbps: 0.0,
        packet_loss_pct: 100.0,
        jitter_ms: 0.0,
        latency_ms,
        fps: 0.0,
        packets_received: 0,
        packets_lost: 1,
        uptime_secs: 0,
    }
}

// ---------------------------------------------------------------------------
// Public metrics / handle types
// ---------------------------------------------------------------------------

/// Snapshot of stream metrics sent from monitor task to app
#[derive(Debug, Clone)]
pub struct MetricsSnapshot {
    pub stream_id: usize,
    pub bitrate_kbps: f64,
    pub packet_loss_pct: f64,
    pub jitter_ms: f64,
    pub latency_ms: f64,
    pub fps: f64,
    pub packets_received: u64,
    pub packets_lost: u64,
    pub uptime_secs: u64,
}

pub struct MonitorHandle {
    pub stream_id: usize,
    pub rx: mpsc::UnboundedReceiver<MetricsSnapshot>,
    _task: tokio::task::JoinHandle<()>,
}

pub struct StreamMonitor;

impl StreamMonitor {
    /// Spawn a monitoring task for a stream.
    ///
    /// - `demo = true`: simulated metrics (for --demo mode)
    /// - `demo = false`, RTSP: DESCRIBE → SETUP → PLAY → 2 s RTP collection → TEARDOWN
    /// - `demo = false`, RTP: simulation placeholder (real monitoring via batch.rs)
    pub fn spawn(
        stream_id: usize,
        url: String,
        protocol: StreamProtocol,
        interval_ms: u64,
        demo: bool,
    ) -> MonitorHandle {
        let (tx, rx) = mpsc::unbounded_channel();

        let task = tokio::spawn(async move {
            if demo {
                // Demo mode: simulate realistic metrics
                let mut ticker = time::interval(Duration::from_millis(interval_ms));
                let mut state = SimState::new(stream_id, &url, protocol);
                loop {
                    ticker.tick().await;
                    state.step();
                    let snapshot = MetricsSnapshot {
                        stream_id,
                        bitrate_kbps: state.bitrate,
                        packet_loss_pct: state.loss,
                        jitter_ms: state.jitter,
                        latency_ms: state.latency,
                        fps: state.fps,
                        packets_received: state.pkts_recv,
                        packets_lost: state.pkts_lost,
                        uptime_secs: state.uptime,
                    };
                    if tx.send(snapshot).is_err() {
                        break;
                    }
                }
            } else if protocol == StreamProtocol::Rtsp {
                // Production RTSP: full DESCRIBE→SETUP→PLAY→RTP probe
                // Sleep interval after each probe to avoid concurrent probes.
                // Minimum 5 s gives ~7-8 s total cycle (probe ~2-3 s + sleep 5 s).
                let probe_interval = Duration::from_millis(interval_ms.max(5_000));
                let mut uptime: u64 = 0;

                // Send an immediate alive snapshot so the stale detector never
                // sees a gap before the first probe completes.
                let init = make_alive(stream_id, 0, 0.0);
                if tx.send(init).is_err() {
                    return;
                }

                loop {
                    let snapshot = rtsp_probe(stream_id, &url, uptime).await;
                    if snapshot.uptime_secs > 0 {
                        uptime = snapshot.uptime_secs;
                    }
                    if tx.send(snapshot).is_err() {
                        break;
                    }
                    // Sleep AFTER the probe so the interval doesn't accumulate
                    // missed ticks when a probe takes longer than expected.
                    time::sleep(probe_interval).await;
                }
            } else {
                // RTP in socket mode: handled by batch.rs; this task is not used
            }
        });

        MonitorHandle {
            stream_id,
            rx,
            _task: task,
        }
    }
}

// ---------------------------------------------------------------------------
// RTSP helpers
// ---------------------------------------------------------------------------

/// Stored Digest credentials reused across SETUP / PLAY requests in a session.
struct AuthCtx {
    username: String,
    password: String,
    realm: String,
    nonce: String,
}

impl AuthCtx {
    /// Build the `Authorization: Digest …\r\n` line for a request.
    fn authorization(&self, method: &str, uri: &str) -> String {
        let auth = compute_digest_auth(
            &self.username,
            &self.password,
            &self.realm,
            &self.nonce,
            method,
            uri,
        );
        format!("Authorization: {}\r\n", auth)
    }
}

/// Find the position of `\r\n\r\n` in a byte buffer (returns index of first `\r`).
fn find_crlfcrlf(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Read a complete RTSP response from the TCP stream.
///
/// Reads until the full header block (`\r\n\r\n`) plus the body announced by
/// `Content-Length` are received.  Returns the raw UTF-8 response string.
async fn read_rtsp_response_full(tcp: &mut TcpStream) -> std::io::Result<String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];

    loop {
        let n = tcp.read(&mut tmp).await?;
        if n == 0 {
            if buf.is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "connection closed before response",
                ));
            }
            break;
        }
        buf.extend_from_slice(&tmp[..n]);

        if let Some(hdr_end) = find_crlfcrlf(&buf) {
            let header_str = String::from_utf8_lossy(&buf[..hdr_end]);
            let content_length = header_str
                .lines()
                .find(|l| l.to_lowercase().starts_with("content-length:"))
                .and_then(|l| l[15..].trim().parse::<usize>().ok())
                .unwrap_or(0);

            let total = hdr_end + 4 + content_length;
            if buf.len() >= total {
                return Ok(String::from_utf8_lossy(&buf[..total]).into_owned());
            }
            // body not yet complete — keep reading
        }

        // Guard against runaway responses
        if buf.len() > 131_072 {
            break;
        }
    }

    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Extract the `Session:` header value (strips any `;timeout=…` suffix).
fn parse_session_id(response: &str) -> Option<String> {
    response
        .lines()
        .find(|l| l.to_lowercase().starts_with("session:"))
        .map(|l| {
            let val = l[8..].trim();
            val.split(';').next().unwrap_or(val).trim().to_string()
        })
}

/// Extract the SDP body from an RTSP response (everything after `\r\n\r\n`).
fn extract_sdp_body(response: &str) -> &str {
    response
        .find("\r\n\r\n")
        .map(|i| &response[i + 4..])
        .unwrap_or("")
}

/// Find the first `a=control:` track URL from an SDP body.
///
/// Returns an absolute `rtsp://` URL; if the SDP value is relative it is
/// appended to `base_url`.
fn parse_track_url(sdp_body: &str, base_url: &str) -> Option<String> {
    for line in sdp_body.lines() {
        if !line.to_lowercase().starts_with("a=control:") {
            continue;
        }
        let control = line[10..].trim();
        if control.is_empty() || control == "*" {
            continue;
        }
        if control.starts_with("rtsp://") {
            return Some(control.to_string());
        }
        // Relative control URL — append to base stream URL
        return Some(format!("{}/{}", base_url.trim_end_matches('/'), control));
    }
    None
}

/// Extract the RTP clock rate from an SDP `a=rtpmap` line.
///
/// Defaults to 90 000 Hz (standard for video) when no rtpmap is found.
fn parse_clock_rate_from_sdp(sdp_body: &str) -> u32 {
    for line in sdp_body.lines() {
        if !line.to_lowercase().starts_with("a=rtpmap:") {
            continue;
        }
        // Format: a=rtpmap:<pt> <EncodingName>/<ClockRate>[/<Channels>]
        let parts: Vec<&str> = line[9..].split_whitespace().collect();
        if parts.len() >= 2 {
            let enc_clock: Vec<&str> = parts[1].split('/').collect();
            if enc_clock.len() >= 2
                && let Ok(rate) = enc_clock[1].parse::<u32>()
            {
                return rate;
            }
        }
    }
    90_000
}

// ---------------------------------------------------------------------------
// RTP collection over interleaved TCP (RFC 2326 §10.12)
// ---------------------------------------------------------------------------

/// Metrics extracted from real RTP packets during the collection window.
struct RtpMetrics {
    fps: f64,
    jitter_ms: f64,
    packet_loss_pct: f64,
    bitrate_kbps: f64,
    packets_received: u64,
    packets_lost: u64,
}

/// Read interleaved RTP frames (`$<ch><len_hi><len_lo><data>`) from `tcp` for
/// `duration_secs` seconds and compute stream quality metrics.
///
/// Any non-interleaved bytes (e.g. RTSP text responses arriving on the same
/// socket) are skipped until the next `$` (0x24) marker is found.
async fn collect_rtp_metrics_interleaved(
    tcp: &mut TcpStream,
    clock_rate: u32,
    duration_secs: u64,
) -> RtpMetrics {
    use crate::rtp::{JitterCalculator, RtpHeader, SequenceTracker};

    let end = tokio::time::Instant::now() + Duration::from_secs(duration_secs);
    let mut jitter_calc = JitterCalculator::new(clock_rate);
    let mut seq_tracker = SequenceTracker::new(0);
    let mut frame_count: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];

    loop {
        let remaining = end.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }

        match tokio::time::timeout(remaining, tcp.read(&mut tmp)).await {
            Ok(Ok(n)) if n > 0 => buf.extend_from_slice(&tmp[..n]),
            _ => break,
        }

        // Drain all complete interleaved frames from buf
        loop {
            if buf.is_empty() {
                break;
            }

            // Skip any non-interleaved bytes (RTSP responses, etc.)
            if buf[0] != 0x24 {
                match buf.iter().position(|&b| b == 0x24) {
                    Some(pos) => buf.drain(..pos),
                    None => {
                        buf.clear();
                        break;
                    }
                };
                continue;
            }

            // Need at least 4 bytes for the interleaved header
            if buf.len() < 4 {
                break;
            }

            let channel = buf[1];
            let frame_len = u16::from_be_bytes([buf[2], buf[3]]) as usize;

            if buf.len() < 4 + frame_len {
                break; // Incomplete frame — wait for more data
            }

            // Channel 0 = RTP video, channel 1 = RTCP; skip odd (RTCP) channels
            if channel.is_multiple_of(2) {
                let frame_data = &buf[4..4 + frame_len];
                if let Some(hdr) = RtpHeader::parse(frame_data) {
                    let arrival_us = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_micros() as i64;

                    jitter_calc.update(arrival_us, hdr.timestamp);
                    seq_tracker.process(hdr.sequence_number);
                    total_bytes += frame_len as u64;

                    // RTP marker bit = last packet of a video frame
                    if hdr.marker {
                        frame_count += 1;
                    }
                }
            }

            buf.drain(..4 + frame_len);
        }
    }

    let elapsed = duration_secs as f64;
    let r = seq_tracker.received();
    let l = seq_tracker.lost();

    RtpMetrics {
        fps: frame_count as f64 / elapsed,
        jitter_ms: jitter_calc.jitter_ms(),
        packet_loss_pct: if r + l == 0 {
            0.0
        } else {
            l as f64 / (r + l) as f64 * 100.0
        },
        bitrate_kbps: total_bytes as f64 * 8.0 / elapsed / 1000.0,
        packets_received: r,
        packets_lost: l,
    }
}

// ---------------------------------------------------------------------------
// Main RTSP probe  (DESCRIBE → SETUP → PLAY → collect → TEARDOWN)
// ---------------------------------------------------------------------------

/// Full RTSP probe with real RTP metrics collection.
///
/// Flow:
/// 1. TCP connect + DESCRIBE (unauthenticated).
/// 2. If 401 → retry DESCRIBE with Digest credentials from the URL.
/// 3. If DESCRIBE ≠ 2xx → return dead.
/// 4. Parse SDP: extract first track URL and clock rate.
/// 5. SETUP with `RTP/AVP/TCP;unicast;interleaved=0-1`.
/// 6. PLAY.
/// 7. Collect interleaved RTP for 2 s → compute jitter / FPS / loss / bitrate.
/// 8. TEARDOWN.
///
/// If any step after a successful DESCRIBE fails the probe returns `make_alive`
/// (the server answered, so the stream is reachable, just not fully measurable).
async fn rtsp_probe(stream_id: usize, url: &str, prev_uptime: u64) -> MetricsSnapshot {
    let parsed = match parse_rtsp_parsed(url) {
        Some(p) => p,
        None => return make_dead(stream_id, 0.0),
    };

    let addr = format!("{}:{}", parsed.host, parsed.port);
    let t0 = Instant::now();

    // Build the credential-free request URI for Digest auth
    let stripped = url.strip_prefix("rtsp://").unwrap_or(url);
    let after_at = if let Some(at) = stripped.rfind('@') {
        &stripped[at + 1..]
    } else {
        stripped
    };
    let request_url = format!("rtsp://{}", after_at);

    // ------------------------------------------------------------------
    // Phase 1: connect + DESCRIBE (no auth)
    // ------------------------------------------------------------------
    let mut tcp = match timeout(Duration::from_secs(2), TcpStream::connect(&addr)).await {
        Ok(Ok(s)) => s,
        _ => return make_dead(stream_id, 0.0),
    };

    let req_describe = format!(
        "DESCRIBE {url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: rtpulse\r\n\r\n",
        url = request_url
    );

    let resp1 = match timeout(Duration::from_secs(2), async {
        tcp.write_all(req_describe.as_bytes()).await?;
        read_rtsp_response_full(&mut tcp).await
    })
    .await
    {
        Ok(Ok(r)) if !r.is_empty() => r,
        _ => return make_dead(stream_id, t0.elapsed().as_secs_f64() * 1000.0),
    };

    // ------------------------------------------------------------------
    // Phase 2: Digest auth retry if needed
    // ------------------------------------------------------------------
    let (describe_resp, auth_ctx) = if resp1.starts_with("RTSP/1.0 401") {
        match (&parsed.username, &parsed.password) {
            (Some(user), Some(pass)) => {
                match parse_digest_challenge(&resp1) {
                    Some((realm, nonce)) => {
                        let ctx = AuthCtx {
                            username: user.clone(),
                            password: pass.clone(),
                            realm: realm.clone(),
                            nonce: nonce.clone(),
                        };
                        let auth_line = ctx.authorization("DESCRIBE", &request_url);
                        let req2 = format!(
                            "DESCRIBE {url} RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\nUser-Agent: rtpulse\r\n{auth}\r\n",
                            url = request_url,
                            auth = auth_line
                        );

                        // Try reusing the existing connection first
                        let resp2 = timeout(Duration::from_secs(2), async {
                            tcp.write_all(req2.as_bytes()).await?;
                            read_rtsp_response_full(&mut tcp).await
                        })
                        .await;

                        let r2 = match resp2 {
                            Ok(Ok(b)) if !b.is_empty() => b,
                            _ => {
                                // Fallback: fresh connection for the auth'd DESCRIBE
                                let mut tcp2 = match timeout(
                                    Duration::from_secs(2),
                                    TcpStream::connect(&addr),
                                )
                                .await
                                {
                                    Ok(Ok(s)) => s,
                                    _ => {
                                        return make_dead(
                                            stream_id,
                                            t0.elapsed().as_secs_f64() * 1000.0,
                                        );
                                    }
                                };
                                match timeout(Duration::from_secs(2), async {
                                    tcp2.write_all(req2.as_bytes()).await?;
                                    read_rtsp_response_full(&mut tcp2).await
                                })
                                .await
                                {
                                    Ok(Ok(b)) if !b.is_empty() => {
                                        tcp = tcp2; // switch to fresh connection
                                        b
                                    }
                                    _ => {
                                        return make_dead(
                                            stream_id,
                                            t0.elapsed().as_secs_f64() * 1000.0,
                                        );
                                    }
                                }
                            }
                        };

                        if r2.starts_with("RTSP/1.0 2") {
                            (r2, Some(ctx))
                        } else if r2.starts_with("RTSP/1.0 401") {
                            // Wrong credentials but server alive
                            return make_alive(
                                stream_id,
                                prev_uptime,
                                t0.elapsed().as_secs_f64() * 1000.0,
                            );
                        } else {
                            return make_dead(stream_id, t0.elapsed().as_secs_f64() * 1000.0);
                        }
                    }
                    None => {
                        // 401 but couldn't parse challenge — server is alive
                        return make_alive(
                            stream_id,
                            prev_uptime,
                            t0.elapsed().as_secs_f64() * 1000.0,
                        );
                    }
                }
            }
            _ => {
                // 401 but no credentials in URL — server alive, auth required
                return make_alive(stream_id, prev_uptime, t0.elapsed().as_secs_f64() * 1000.0);
            }
        }
    } else if resp1.starts_with("RTSP/1.0 2") {
        (resp1, None)
    } else {
        // 4xx (not 401) or 5xx → dead
        return make_dead(stream_id, t0.elapsed().as_secs_f64() * 1000.0);
    };

    let latency_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ------------------------------------------------------------------
    // Phase 3: Parse SDP for track URL and clock rate
    // ------------------------------------------------------------------
    let sdp_body = extract_sdp_body(&describe_resp);
    let clock_rate = parse_clock_rate_from_sdp(sdp_body);

    let track_url = match parse_track_url(sdp_body, &request_url) {
        Some(t) => t,
        None => {
            // No track in SDP — server is alive but we can't go further
            return make_alive(stream_id, prev_uptime, latency_ms);
        }
    };

    // ------------------------------------------------------------------
    // Phase 4: SETUP — request TCP interleaved transport
    // ------------------------------------------------------------------
    let setup_auth = match &auth_ctx {
        Some(ctx) => ctx.authorization("SETUP", &track_url),
        None => String::new(),
    };

    let req_setup = format!(
        "SETUP {track} RTSP/1.0\r\nCSeq: 3\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nUser-Agent: rtpulse\r\n{auth}\r\n",
        track = track_url,
        auth = setup_auth,
    );

    let setup_resp = match timeout(Duration::from_secs(2), async {
        tcp.write_all(req_setup.as_bytes()).await?;
        read_rtsp_response_full(&mut tcp).await
    })
    .await
    {
        Ok(Ok(r)) if !r.is_empty() => r,
        _ => return make_alive(stream_id, prev_uptime, latency_ms),
    };

    if !setup_resp.starts_with("RTSP/1.0 2") {
        return make_alive(stream_id, prev_uptime, latency_ms);
    }

    let session_id = match parse_session_id(&setup_resp) {
        Some(s) => s,
        None => return make_alive(stream_id, prev_uptime, latency_ms),
    };

    // ------------------------------------------------------------------
    // Phase 5: PLAY
    // ------------------------------------------------------------------
    let play_auth = match &auth_ctx {
        Some(ctx) => ctx.authorization("PLAY", &request_url),
        None => String::new(),
    };

    let req_play = format!(
        "PLAY {url} RTSP/1.0\r\nCSeq: 4\r\nSession: {session}\r\nRange: npt=0.000-\r\nUser-Agent: rtpulse\r\n{auth}\r\n",
        url = request_url,
        session = session_id,
        auth = play_auth,
    );

    let play_resp = match timeout(Duration::from_secs(2), async {
        tcp.write_all(req_play.as_bytes()).await?;
        read_rtsp_response_full(&mut tcp).await
    })
    .await
    {
        Ok(Ok(r)) if !r.is_empty() => r,
        _ => {
            send_teardown(&mut tcp, &request_url, &session_id, auth_ctx.as_ref()).await;
            return make_alive(stream_id, prev_uptime, latency_ms);
        }
    };

    if !play_resp.starts_with("RTSP/1.0 2") {
        send_teardown(&mut tcp, &request_url, &session_id, auth_ctx.as_ref()).await;
        return make_alive(stream_id, prev_uptime, latency_ms);
    }

    // ------------------------------------------------------------------
    // Phase 6: Collect interleaved RTP packets for 2 seconds
    // ------------------------------------------------------------------
    let rtp = collect_rtp_metrics_interleaved(&mut tcp, clock_rate, 2).await;

    // ------------------------------------------------------------------
    // Phase 7: TEARDOWN
    // ------------------------------------------------------------------
    send_teardown(&mut tcp, &request_url, &session_id, auth_ctx.as_ref()).await;

    // ------------------------------------------------------------------
    // Build snapshot from measured metrics
    // ------------------------------------------------------------------
    // If we received no RTP packets (e.g. server sent no data in 2 s),
    // fall back to make_alive so the stream isn't marked Down.
    if rtp.packets_received == 0 && rtp.fps == 0.0 {
        return make_alive(stream_id, prev_uptime, latency_ms);
    }

    MetricsSnapshot {
        stream_id,
        bitrate_kbps: rtp.bitrate_kbps,
        packet_loss_pct: rtp.packet_loss_pct,
        jitter_ms: rtp.jitter_ms,
        latency_ms,
        fps: rtp.fps,
        packets_received: rtp.packets_received,
        packets_lost: rtp.packets_lost,
        uptime_secs: prev_uptime + 1,
    }
}

/// Send a TEARDOWN request, ignoring any errors (best-effort cleanup).
async fn send_teardown(
    tcp: &mut TcpStream,
    url: &str,
    session_id: &str,
    auth_ctx: Option<&AuthCtx>,
) {
    let auth = match auth_ctx {
        Some(ctx) => ctx.authorization("TEARDOWN", url),
        None => String::new(),
    };
    let req = format!(
        "TEARDOWN {url} RTSP/1.0\r\nCSeq: 5\r\nSession: {session}\r\nUser-Agent: rtpulse\r\n{auth}\r\n",
        url = url,
        session = session_id,
        auth = auth,
    );
    let _ = timeout(Duration::from_secs(1), tcp.write_all(req.as_bytes())).await;
}

// ---------------------------------------------------------------------------
// Simulation state — used only in --demo mode
// ---------------------------------------------------------------------------

struct SimState {
    stream_id: usize,
    bitrate: f64,
    loss: f64,
    jitter: f64,
    latency: f64,
    fps: f64,
    pkts_recv: u64,
    pkts_lost: u64,
    uptime: u64,
    tick: u64,
    base_bitrate: f64,
    volatility: f64,
    degradation_cycle: u64,
    severe_event_cycle: u64,
    severe_phase: u64,
}

impl SimState {
    fn new(stream_id: usize, url: &str, protocol: StreamProtocol) -> Self {
        let hash = url
            .bytes()
            .fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
        let base_bitrate = match protocol {
            StreamProtocol::Rtsp => 2000.0 + (hash % 6000) as f64,
            StreamProtocol::Rtp => 1000.0 + (hash % 8000) as f64,
        };
        let volatility = 0.02 + (hash % 100) as f64 * 0.001;
        let degradation_cycle = 30 + (stream_id as u64 * 17) % 60;
        let severe_event_cycle = 18 + (hash % 24);
        let severe_lead = 8 + (hash % 10);
        let severe_phase = (severe_event_cycle - severe_lead) % severe_event_cycle;

        Self {
            stream_id,
            bitrate: base_bitrate,
            loss: 0.1,
            jitter: 2.0,
            latency: 15.0,
            fps: 30.0,
            pkts_recv: 0,
            pkts_lost: 0,
            uptime: 0,
            tick: 0,
            base_bitrate,
            volatility,
            degradation_cycle,
            severe_event_cycle,
            severe_phase,
        }
    }

    fn step(&mut self) {
        self.tick += 1;
        self.uptime += 1;

        let noise = || -> f64 {
            let x = self
                .tick
                .wrapping_mul(6364136223846793005)
                .wrapping_add(self.stream_id as u64);
            let bits = ((x >> 33) ^ x).wrapping_mul(0xff51afd7ed558ccd);
            let bits = ((bits >> 33) ^ bits).wrapping_mul(0xc4ceb9fe1a85ec53);
            let bits = (bits >> 33) ^ bits;
            (bits % 10000) as f64 / 10000.0
        };

        let cycle_pos = (self.tick % self.degradation_cycle) as f64 / self.degradation_cycle as f64;
        let degradation = if cycle_pos > 0.8 {
            (cycle_pos - 0.8) * 5.0
        } else {
            0.0
        };

        let severe = if (self.tick + self.severe_phase) % self.severe_event_cycle < 4 {
            1.0
        } else {
            0.0
        };

        let n = noise();

        self.bitrate = self.base_bitrate
            * (1.0 - degradation * 0.4 - severe * 0.9)
            * (1.0 + (n - 0.5) * self.volatility * 2.0);
        self.bitrate = self.bitrate.max(0.0);

        self.loss = 0.1 + degradation * 8.0 + severe * 25.0 + n * 0.5;
        self.loss = self.loss.clamp(0.0, 100.0);

        self.jitter = 2.0 + degradation * 40.0 + severe * 100.0 + n * 5.0;
        self.jitter = self.jitter.max(0.0);

        self.latency = 15.0 + degradation * 30.0 + severe * 200.0 + n * 3.0;
        self.latency = self.latency.max(0.0);

        self.fps = 30.0 * (1.0 - degradation * 0.5 - severe * 0.8) + (n - 0.5) * 2.0;
        self.fps = self.fps.clamp(0.0, 60.0);

        let new_pkts = (self.bitrate / 8.0 * 1000.0 / 1316.0) as u64;
        self.pkts_recv += new_pkts;
        let lost = (new_pkts as f64 * self.loss / 100.0) as u64;
        self.pkts_lost += lost;
    }
}
