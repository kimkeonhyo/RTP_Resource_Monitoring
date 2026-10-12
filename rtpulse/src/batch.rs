use crate::rtp::{JitterCalculator, RtpHeader, SequenceTracker};
use anyhow::Result;
use mio::net::UdpSocket;
use mio::{Events, Interest, Poll, Token};
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ─── Shared metrics output ──────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct BatchMetrics {
    pub bitrate_kbps: f64,
    pub packet_loss_pct: f64,
    pub jitter_ms: f64,
    pub packets_received: u64,
    pub packets_lost: u64,
    #[allow(dead_code)]
    pub bytes_received: u64,
    #[allow(dead_code)]
    pub last_packet: Option<Instant>,
}

pub type SharedMetricsMap = Arc<Mutex<HashMap<usize, BatchMetrics>>>;

// ─── Per-stream tracking state ──────────────────────────────────────────────

struct StreamState {
    stream_id: usize,
    seq_tracker: SequenceTracker,
    jitter_calc: JitterCalculator,
    bytes_window: u64,
    window_start: Instant,
    packets_received: u64,
    packets_lost: u64,
}

// ─── Batch receiver ─────────────────────────────────────────────────────────

/// Configuration for one RTP endpoint to monitor
#[derive(Debug, Clone)]
pub struct RtpEndpoint {
    pub stream_id: usize,
    pub bind_addr: SocketAddr,
    /// If Some, join this multicast group
    pub multicast_group: Option<Ipv4Addr>,
}

impl RtpEndpoint {
    pub fn parse(stream_id: usize, url: &str) -> Option<Self> {
        let stripped = url.strip_prefix("rtp://")?;
        let parts: Vec<&str> = stripped.split(':').collect();
        if parts.len() != 2 {
            return None;
        }

        let ip: Ipv4Addr = parts[0].parse().ok()?;
        let port: u16 = parts[1].parse().ok()?;

        let multicast = if ip.is_multicast() { Some(ip) } else { None };

        let bind_addr = if multicast.is_some() {
            // Bind to INADDR_ANY for multicast
            SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), port)
        } else {
            SocketAddr::new(ip.into(), port)
        };

        Some(Self {
            stream_id,
            bind_addr,
            multicast_group: multicast,
        })
    }
}

/// Single-thread batch receiver using mio epoll.
///
/// Handles hundreds of RTP streams on one OS thread by multiplexing
/// UDP sockets through epoll. Much more efficient than one tokio task
/// per stream.
///
/// # Architecture
///
/// ```text
///   UDP Socket 1 ──┐
///   UDP Socket 2 ──┤
///   UDP Socket 3 ──┼──→ mio::Poll (epoll) ──→ single thread
///   ...            │         │
///   UDP Socket N ──┘         ▼
///                     parse RTP headers
///                     update per-stream state
///                     write to SharedMetricsMap
///                            │
///                            ▼
///                     App reads metrics (lock-free-ish)
/// ```
pub struct BatchReceiver {
    endpoints: Vec<RtpEndpoint>,
    metrics: SharedMetricsMap,
}

impl BatchReceiver {
    pub fn new(endpoints: Vec<RtpEndpoint>) -> (Self, SharedMetricsMap) {
        let metrics = Arc::new(Mutex::new(HashMap::new()));
        (
            Self {
                endpoints,
                metrics: metrics.clone(),
            },
            metrics,
        )
    }

    /// Spawn the receiver on a dedicated OS thread (not tokio task).
    /// This keeps the epoll loop independent of the async runtime.
    pub fn spawn(self) -> std::thread::JoinHandle<()> {
        std::thread::Builder::new()
            .name("batch-rtp-recv".to_string())
            .spawn(move || {
                if let Err(e) = self.run_loop() {
                    tracing::error!("Batch receiver error: {e}");
                }
            })
            .expect("failed to spawn batch receiver thread")
    }

    fn run_loop(self) -> Result<()> {
        let mut poll = Poll::new()?;
        let mut events = Events::with_capacity(256);
        let mut sockets: Vec<UdpSocket> = Vec::new();
        let mut states: HashMap<usize, StreamState> = HashMap::new(); // token → state
        let mut buf = [0u8; 2048];

        // Set up all sockets
        for (idx, ep) in self.endpoints.iter().enumerate() {
            let mut socket = create_udp_socket(ep)?;
            poll.registry()
                .register(&mut socket, Token(idx), Interest::READABLE)?;
            sockets.push(socket);
            states.insert(
                idx,
                StreamState {
                    stream_id: ep.stream_id,
                    seq_tracker: SequenceTracker::new(0),
                    jitter_calc: JitterCalculator::new(90000), // 90kHz default for video
                    bytes_window: 0,
                    window_start: Instant::now(),
                    packets_received: 0,
                    packets_lost: 0,
                },
            );
        }

        let mut last_metrics_push = Instant::now();
        let metrics_interval = Duration::from_secs(1);

        loop {
            poll.poll(&mut events, Some(Duration::from_millis(100)))?;

            for event in events.iter() {
                let token_idx = event.token().0;
                if token_idx >= sockets.len() {
                    continue;
                }

                // Drain all available packets (edge-triggered style)
                loop {
                    match sockets[token_idx].recv_from(&mut buf) {
                        Ok((len, _addr)) => {
                            if let Some(state) = states.get_mut(&token_idx) {
                                process_packet(state, &buf[..len]);
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(_) => break,
                    }
                }
            }

            // Periodically push aggregated metrics
            if last_metrics_push.elapsed() >= metrics_interval {
                let mut map = self.metrics.lock().unwrap();
                for state in states.values_mut() {
                    let elapsed = state.window_start.elapsed().as_secs_f64().max(0.001);
                    let bitrate = (state.bytes_window as f64 * 8.0) / elapsed / 1000.0;

                    map.insert(
                        state.stream_id,
                        BatchMetrics {
                            bitrate_kbps: bitrate,
                            packet_loss_pct: state.seq_tracker.loss_ratio(),
                            jitter_ms: state.jitter_calc.jitter_ms(),
                            packets_received: state.packets_received,
                            packets_lost: state.packets_lost,
                            bytes_received: state.bytes_window,
                            last_packet: Some(Instant::now()),
                        },
                    );

                    // Reset window
                    state.bytes_window = 0;
                    state.window_start = Instant::now();
                }
                last_metrics_push = Instant::now();
            }
        }
    }
}

fn process_packet(state: &mut StreamState, data: &[u8]) {
    state.packets_received += 1;
    state.bytes_window += data.len() as u64;

    if let Some(header) = RtpHeader::parse(data) {
        // Update SSRC if first packet
        if state.seq_tracker.ssrc == 0 {
            state.seq_tracker = SequenceTracker::new(header.ssrc);
        }

        let lost = state.seq_tracker.process(header.sequence_number);
        state.packets_lost += lost;

        let now_us = Instant::now().elapsed().as_micros() as i64;
        state.jitter_calc.update(now_us, header.timestamp);
    }
}

fn create_udp_socket(ep: &RtpEndpoint) -> Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;

    // Allow multiple listeners on same port (common for multicast)
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;

    socket.set_nonblocking(true)?;
    socket.bind(&SockAddr::from(ep.bind_addr))?;

    // Join multicast group if specified
    if let Some(group) = ep.multicast_group {
        socket.join_multicast_v4(&group, &Ipv4Addr::UNSPECIFIED)?;
    }

    // Convert socket2::Socket → mio::net::UdpSocket
    let std_socket: std::net::UdpSocket = socket.into();
    Ok(UdpSocket::from_std(std_socket))
}
