//! Unified packet capture module for RTSP and RTP monitoring.
//!
//! Uses pcap to passively capture network traffic and extract metrics:
//! - Parses RTSP SETUP/PLAY to learn dynamic RTP port assignments
//! - Captures RTP packets to compute bitrate, packet loss, jitter
//! - Captures RTCP SR/RR for server-side statistics

use crate::rtp::{JitterCalculator, RtpHeader, SequenceTracker};
use anyhow::{Context, Result};
use pcap::{Capture, Device};
use pnet::packet::{
    Packet,
    ethernet::{EtherTypes, EthernetPacket},
    ip::IpNextHeaderProtocols,
    ipv4::Ipv4Packet,
    tcp::TcpPacket,
    udp::UdpPacket,
};
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Metrics collected from packet capture
#[derive(Debug, Clone, Default)]
pub struct CaptureMetrics {
    pub bitrate_kbps: f64,
    pub packet_loss_pct: f64,
    pub jitter_ms: f64,
    pub packets_received: u64,
    pub packets_lost: u64,
    pub bytes_received: u64,
    pub last_packet: Option<Instant>,
    pub rtcp_rtt_ms: Option<f64>,
    pub rtcp_jitter_ms: Option<f64>,
}

/// Shared metrics map: stream_id -> metrics
pub type SharedCaptureMetrics = Arc<Mutex<HashMap<usize, CaptureMetrics>>>;

/// Stream endpoint information
#[derive(Debug, Clone)]
pub struct StreamEndpoint {
    pub stream_id: usize,
    pub name: String,
    /// Original URL (needed for RTSP path matching)
    pub url: String,
    /// For RTSP: the server IP; for RTP multicast: the multicast group
    pub target_ip: Ipv4Addr,
    /// RTP port (even number, RTCP is port+1)
    pub rtp_port: u16,
    /// True if this is multicast
    pub is_multicast: bool,
}

/// Per-stream capture state
struct StreamState {
    endpoint: StreamEndpoint,
    seq_tracker: SequenceTracker,
    jitter_calc: JitterCalculator,
    bytes_window: u64,
    packets_window: u64,
    window_start: Instant,
    total_packets: u64,
    total_lost: u64,
    last_packet: Option<Instant>,
    // RTCP stats
    rtcp_rtt_ms: Option<f64>,
    rtcp_jitter_ms: Option<f64>,
}

impl StreamState {
    fn new(endpoint: StreamEndpoint) -> Self {
        Self {
            endpoint,
            seq_tracker: SequenceTracker::new(0),
            jitter_calc: JitterCalculator::new(90000), // 90kHz default for video
            bytes_window: 0,
            packets_window: 0,
            window_start: Instant::now(),
            total_packets: 0,
            total_lost: 0,
            last_packet: None,
            rtcp_rtt_ms: None,
            rtcp_jitter_ms: None,
        }
    }

    fn to_metrics(&self) -> CaptureMetrics {
        let elapsed = self.window_start.elapsed().as_secs_f64().max(0.001);
        let bitrate = (self.bytes_window as f64 * 8.0) / elapsed / 1000.0;

        CaptureMetrics {
            bitrate_kbps: bitrate,
            packet_loss_pct: self.seq_tracker.loss_ratio(),
            jitter_ms: self.jitter_calc.jitter_ms(),
            packets_received: self.total_packets,
            packets_lost: self.total_lost,
            bytes_received: self.bytes_window,
            last_packet: self.last_packet,
            rtcp_rtt_ms: self.rtcp_rtt_ms,
            rtcp_jitter_ms: self.rtcp_jitter_ms,
        }
    }

    fn reset_window(&mut self) {
        self.bytes_window = 0;
        self.packets_window = 0;
        self.window_start = Instant::now();
    }
}

/// RTSP session tracker - learns RTP ports from SETUP responses
struct RtspSessionTracker {
    /// Maps normalized URL path (host:port/path) -> stream_id
    path_to_stream: HashMap<String, usize>,
    /// Maps client_ip -> stream_id currently being set up (from SETUP request)
    active_setups: HashMap<Ipv4Addr, usize>,
    /// Maps (server_ip, rtp_port) -> stream_id
    port_mappings: HashMap<(Ipv4Addr, u16), usize>,
}

impl RtspSessionTracker {
    fn new() -> Self {
        Self {
            path_to_stream: HashMap::new(),
            active_setups: HashMap::new(),
            port_mappings: HashMap::new(),
        }
    }

    /// Register a stream we want to monitor
    fn register_stream(&mut self, stream_id: usize, url: &str) {
        if let Some(stripped) = url.strip_prefix("rtsp://") {
            let key = stripped
                .split('@')
                .last()
                .unwrap_or(stripped)
                .trim_end_matches('/')
                .to_string();
            self.path_to_stream.insert(key, stream_id);
        }
    }

    /// Called when we see a SETUP request (client -> server).
    /// Records which stream this client is setting up so we can correlate the response.
    fn on_setup_request(&mut self, payload: &[u8], client_ip: Ipv4Addr) {
        let Ok(text) = std::str::from_utf8(payload) else {
            return;
        };
        let first_line = text.lines().next().unwrap_or("");
        let mut parts = first_line.split_whitespace();
        if parts.next() != Some("SETUP") {
            return;
        }
        let url = match parts.next() {
            Some(u) => u,
            None => return,
        };
        let key = url
            .strip_prefix("rtsp://")
            .unwrap_or(url)
            .split('@')
            .last()
            .unwrap_or(url)
            .trim_end_matches('/');

        // Match against registered stream paths (SETUP URL often includes /trackID=0 suffix)
        for (path, &stream_id) in &self.path_to_stream {
            if key.starts_with(path.as_str()) {
                self.active_setups.insert(client_ip, stream_id);
                return;
            }
        }
    }

    /// Called when we see an RTSP response (server -> client).
    /// Returns (stream_id, rtp_port) if a SETUP response with Transport header is detected.
    fn on_response(
        &mut self,
        payload: &[u8],
        server_ip: Ipv4Addr,
        client_ip: Ipv4Addr,
    ) -> Option<(usize, u16)> {
        let text = std::str::from_utf8(payload).ok()?;
        if !text.contains("Transport:") {
            return None;
        }
        for line in text.lines() {
            if line.to_lowercase().starts_with("transport:") {
                if let Some(port) = self.extract_rtp_port(line) {
                    if let Some(&stream_id) = self.active_setups.get(&client_ip) {
                        self.port_mappings.insert((server_ip, port), stream_id);
                        return Some((stream_id, port));
                    }
                }
            }
        }
        None
    }

    fn extract_rtp_port(&self, transport_line: &str) -> Option<u16> {
        // Try server_port=XXXX-YYYY
        if let Some(idx) = transport_line.find("server_port=") {
            let rest = &transport_line[idx + 12..];
            if let Some(port_str) = rest.split(&['-', ';', ' ', '\r', '\n'][..]).next() {
                return port_str.parse().ok();
            }
        }
        // Try port=XXXX-YYYY
        if let Some(idx) = transport_line.find("port=") {
            let rest = &transport_line[idx + 5..];
            if let Some(port_str) = rest.split(&['-', ';', ' ', '\r', '\n'][..]).next() {
                return port_str.parse().ok();
            }
        }
        // Try client_port for cases where we're the client
        if let Some(idx) = transport_line.find("client_port=") {
            let rest = &transport_line[idx + 12..];
            if let Some(port_str) = rest.split(&['-', ';', ' ', '\r', '\n'][..]).next() {
                return port_str.parse().ok();
            }
        }
        None
    }

    fn get_stream_id(&self, ip: Ipv4Addr, port: u16) -> Option<usize> {
        self.port_mappings.get(&(ip, port)).copied()
    }
}

/// Packet capture based monitor
pub struct CaptureMonitor {
    interface: String,
    endpoints: Vec<StreamEndpoint>,
    metrics: SharedCaptureMetrics,
}

impl CaptureMonitor {
    pub fn new(interface: String, endpoints: Vec<StreamEndpoint>) -> (Self, SharedCaptureMetrics) {
        let metrics = Arc::new(Mutex::new(HashMap::new()));
        (
            Self {
                interface,
                endpoints,
                metrics: metrics.clone(),
            },
            metrics,
        )
    }

    /// Parse a stream URL into an endpoint
    pub fn parse_endpoint(stream_id: usize, name: &str, url: &str) -> Option<StreamEndpoint> {
        if let Some(stripped) = url.strip_prefix("rtp://") {
            // RTP multicast: rtp://239.1.1.1:5004
            let parts: Vec<&str> = stripped.split(':').collect();
            if parts.len() == 2 {
                let ip: Ipv4Addr = parts[0].parse().ok()?;
                let port: u16 = parts[1].parse().ok()?;
                return Some(StreamEndpoint {
                    stream_id,
                    name: name.to_string(),
                    url: url.to_string(),
                    target_ip: ip,
                    rtp_port: port,
                    is_multicast: ip.is_multicast(),
                });
            }
        } else if let Some(stripped) = url.strip_prefix("rtsp://") {
            // RTSP: rtsp://host:554/path - extract server IP
            // Port will be learned from SETUP response
            let host_part = stripped.split('/').next()?;
            let host = host_part.split(':').next()?;
            let host = host.split('@').last()?; // Handle user:pass@host

            // Try to resolve hostname (for now, just try parsing as IP)
            if let Ok(ip) = host.parse::<Ipv4Addr>() {
                return Some(StreamEndpoint {
                    stream_id,
                    name: name.to_string(),
                    url: url.to_string(),
                    target_ip: ip,
                    rtp_port: 0, // Will be learned from SETUP
                    is_multicast: false,
                });
            }
            // For hostname, we'd need DNS resolution - skip for now
            // Return with placeholder, will try to match by other means
            return Some(StreamEndpoint {
                stream_id,
                name: name.to_string(),
                url: url.to_string(),
                target_ip: Ipv4Addr::new(0, 0, 0, 0),
                rtp_port: 0,
                is_multicast: false,
            });
        }
        None
    }

    /// Spawn the capture thread
    pub fn spawn(self) -> std::thread::JoinHandle<()> {
        std::thread::Builder::new()
            .name("pcap-capture".to_string())
            .spawn(move || {
                if let Err(e) = self.run_capture() {
                    tracing::error!("Capture error: {}", e);
                }
            })
            .expect("failed to spawn capture thread")
    }

    fn run_capture(self) -> Result<()> {
        let mut cap = Capture::from_device(self.interface.as_str())?
            .promisc(true)
            .snaplen(65535)
            .timeout(100)
            .open()
            .context("Failed to open capture device")?;

        // Build filter for RTSP and RTP traffic
        let filter = self.build_filter();
        cap.filter(&filter, true)
            .context("Failed to set capture filter")?;

        // Initialize state for each endpoint
        let mut states: HashMap<usize, StreamState> = HashMap::new();
        for ep in &self.endpoints {
            states.insert(ep.stream_id, StreamState::new(ep.clone()));
        }

        // RTSP session tracker for dynamic port learning
        let mut rtsp_tracker = RtspSessionTracker::new();
        for ep in &self.endpoints {
            if !ep.is_multicast && ep.rtp_port == 0 {
                // This is an RTSP stream - register for port learning
                rtsp_tracker.register_stream(ep.stream_id, &ep.url);
            }
        }

        let mut last_metrics_push = Instant::now();
        let metrics_interval = Duration::from_secs(1);

        loop {
            match cap.next_packet() {
                Ok(packet) => {
                    self.process_packet(packet.data, &mut states, &mut rtsp_tracker);
                }
                Err(pcap::Error::TimeoutExpired) => {}
                Err(e) => {
                    tracing::warn!("Capture error: {}", e);
                }
            }

            // Periodically push metrics
            if last_metrics_push.elapsed() >= metrics_interval {
                let mut map = self.metrics.lock().unwrap();
                for (stream_id, state) in &mut states {
                    map.insert(*stream_id, state.to_metrics());
                    state.reset_window();
                }
                last_metrics_push = Instant::now();
            }
        }
    }

    fn build_filter(&self) -> String {
        let mut filters = Vec::new();

        // Always capture RTSP (port 554)
        filters.push("tcp port 554".to_string());

        for ep in &self.endpoints {
            if ep.rtp_port > 0 {
                // RTP port (even) and RTCP port (odd)
                filters.push(format!("udp port {}", ep.rtp_port));
                filters.push(format!("udp port {}", ep.rtp_port + 1));
            }
            if ep.is_multicast {
                filters.push(format!("dst host {}", ep.target_ip));
            } else if !ep.target_ip.is_unspecified() {
                // Capture all UDP traffic from RTSP server so we catch RTP
                // even when the port is learned dynamically via SETUP
                filters.push(format!("(udp and src host {})", ep.target_ip));
            }
        }

        // Also capture common RTP port ranges for dynamic discovery
        filters.push("udp portrange 5000-5100".to_string());
        filters.push("udp portrange 6000-6100".to_string());

        filters.join(" or ")
    }

    fn process_packet(
        &self,
        data: &[u8],
        states: &mut HashMap<usize, StreamState>,
        rtsp_tracker: &mut RtspSessionTracker,
    ) {
        if let Some(ethernet) = EthernetPacket::new(data) {
            if ethernet.get_ethertype() == EtherTypes::Ipv4 {
                if let Some(ipv4) = Ipv4Packet::new(ethernet.payload()) {
                    match ipv4.get_next_level_protocol() {
                        IpNextHeaderProtocols::Tcp => {
                            if let Some(tcp) = TcpPacket::new(ipv4.payload()) {
                                self.process_tcp(&tcp, &ipv4, states, rtsp_tracker);
                            }
                        }
                        IpNextHeaderProtocols::Udp => {
                            if let Some(udp) = UdpPacket::new(ipv4.payload()) {
                                self.process_udp(&udp, &ipv4, states, rtsp_tracker);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    fn process_tcp(
        &self,
        tcp: &TcpPacket,
        ipv4: &Ipv4Packet,
        _states: &mut HashMap<usize, StreamState>,
        rtsp_tracker: &mut RtspSessionTracker,
    ) {
        let src_port = tcp.get_source();
        let dst_port = tcp.get_destination();

        // RTSP traffic
        if src_port == 554 || dst_port == 554 {
            let is_from_server = src_port == 554;
            let server_ip = if is_from_server {
                ipv4.get_source()
            } else {
                ipv4.get_destination()
            };
            let client_ip = if is_from_server {
                ipv4.get_destination()
            } else {
                ipv4.get_source()
            };

            let payload = tcp.payload();
            if !payload.is_empty() {
                if is_from_server {
                    // Server -> client: look for SETUP response with Transport header
                    if let Some((stream_id, port)) =
                        rtsp_tracker.on_response(payload, server_ip, client_ip)
                    {
                        tracing::info!(
                            "Learned RTP port {} for stream {} from RTSP SETUP",
                            port,
                            stream_id
                        );
                    }
                } else {
                    // Client -> server: track SETUP requests to correlate with responses
                    rtsp_tracker.on_setup_request(payload, client_ip);
                }
            }
        }
    }

    fn process_udp(
        &self,
        udp: &UdpPacket,
        ipv4: &Ipv4Packet,
        states: &mut HashMap<usize, StreamState>,
        rtsp_tracker: &mut RtspSessionTracker,
    ) {
        let src_ip = ipv4.get_source();
        let dst_ip = ipv4.get_destination();
        let src_port = udp.get_source();
        let dst_port = udp.get_destination();
        let payload = udp.payload();

        if payload.len() < 2 {
            return;
        }

        // Determine if this is RTP (even port) or RTCP (odd port)
        let is_rtcp = dst_port % 2 == 1;

        // Try to find the stream this packet belongs to
        let stream_id =
            self.find_stream_for_packet(src_ip, dst_ip, src_port, dst_port, states, rtsp_tracker);

        if let Some(stream_id) = stream_id {
            if let Some(state) = states.get_mut(&stream_id) {
                if is_rtcp {
                    self.process_rtcp(payload, state);
                } else {
                    self.process_rtp(payload, state);
                }
            }
        }
    }

    fn find_stream_for_packet(
        &self,
        src_ip: Ipv4Addr,
        dst_ip: Ipv4Addr,
        _src_port: u16,
        dst_port: u16,
        states: &HashMap<usize, StreamState>,
        rtsp_tracker: &RtspSessionTracker,
    ) -> Option<usize> {
        let rtp_port = if dst_port % 2 == 1 {
            dst_port - 1
        } else {
            dst_port
        };

        // Check for multicast RTP
        if dst_ip.is_multicast() {
            for (stream_id, state) in states {
                if state.endpoint.target_ip == dst_ip && state.endpoint.rtp_port == rtp_port {
                    return Some(*stream_id);
                }
            }
        }

        // Check RTSP learned mappings
        if let Some(stream_id) = rtsp_tracker.get_stream_id(src_ip, rtp_port) {
            return Some(stream_id);
        }

        // Check direct port matches
        for (stream_id, state) in states {
            if state.endpoint.rtp_port == rtp_port {
                if state.endpoint.target_ip == src_ip || state.endpoint.target_ip == dst_ip {
                    return Some(*stream_id);
                }
            }
        }

        None
    }

    fn process_rtp(&self, payload: &[u8], state: &mut StreamState) {
        state.bytes_window += payload.len() as u64;
        state.packets_window += 1;
        state.total_packets += 1;
        state.last_packet = Some(Instant::now());

        if let Some(header) = RtpHeader::parse(payload) {
            // Update SSRC on first packet
            if state.seq_tracker.ssrc == 0 {
                state.seq_tracker = SequenceTracker::new(header.ssrc);
            }

            let lost = state.seq_tracker.process(header.sequence_number);
            state.total_lost += lost;

            // Calculate jitter
            let now_us = Instant::now().elapsed().as_micros() as i64;
            state.jitter_calc.update(now_us, header.timestamp);
        }
    }

    fn process_rtcp(&self, payload: &[u8], state: &mut StreamState) {
        // Parse RTCP packets for additional stats
        // RTCP packet format: V=2, P, RC, PT, length, SSRC, ...
        if payload.len() < 8 {
            return;
        }

        let version = (payload[0] >> 6) & 0x03;
        if version != 2 {
            return;
        }

        let packet_type = payload[1];

        match packet_type {
            200 => {
                // Sender Report (SR)
                // Contains NTP timestamp, RTP timestamp, packet count, octet count
            }
            201 => {
                // Receiver Report (RR)
                // Contains fraction lost, cumulative lost, jitter, LSR, DLSR
                if payload.len() >= 32 {
                    // Parse jitter from RR (bytes 16-19 of report block)
                    let jitter_samples =
                        u32::from_be_bytes([payload[16], payload[17], payload[18], payload[19]]);
                    // Convert from timestamp units to ms (assuming 90kHz clock)
                    state.rtcp_jitter_ms = Some(jitter_samples as f64 / 90.0);
                }
            }
            _ => {}
        }
    }
}

/// List available network interfaces
pub fn list_interfaces() -> Result<Vec<String>> {
    let devices = Device::list().context("Failed to list network devices")?;
    Ok(devices.into_iter().map(|d| d.name).collect())
}

/// Find a suitable default interface
pub fn default_interface() -> Result<String> {
    let interfaces = list_interfaces()?;
    if interfaces.is_empty() {
        anyhow::bail!("No network interfaces found");
    }

    let preferred = ["eth0", "en0", "ens33", "enp0s3", "wlan0", "wlp2s0"];
    interfaces
        .iter()
        .find(|i| preferred.contains(&i.as_str()))
        .or(interfaces.first())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("No suitable interface found"))
}
