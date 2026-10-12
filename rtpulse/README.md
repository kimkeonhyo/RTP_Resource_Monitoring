# rtpulse

Terminal UI for real-time RTSP/RTP stream health monitoring.

![Rust](https://img.shields.io/badge/Rust-1.75+-orange)
![Version](https://img.shields.io/badge/version-v0.5.2-blue)

## Features

- **Real-time monitoring** — RTSP/RTP stream health with Healthy / Degraded / Down status
- **Full RTSP probe** — DESCRIBE → SETUP → PLAY → RTP collection → TEARDOWN with Digest auth
- **Actual RTP metrics** — bitrate, packet loss, jitter (RFC 3550), latency, FPS via RTP marker bit
- **Five views** — Dashboard, Overview, Detail, Logs, Stats
- **Sparkline charts** — per-stream metric history
- **SQLite-backed stats** — daily / 7-day / 30-day down-event history
- **Excel export** — `e` key exports stats to `.xlsx`
- **Alert system** — Slack webhooks on packet loss / jitter / bitrate thresholds
- **Network discovery** — auto-discover RTSP/RTP streams via pcap (optional)

---

## Quick Start

```bash
# Demo mode (simulated streams)
cargo run --release -- --demo

# Monitor streams directly
cargo run --release -- -s rtsp://user:pass@camera:554/live

# Use a config file
cargo run --release -- -c config.yaml

# Capture mode (requires libpcap-dev)
cargo run --release --features pcap-capture -- -I eth0 -c config.yaml
```

---

## Installation

Build from source (Rust 1.75+):

```bash
cargo build --release
```

---

## Configuration

### config.yaml

```yaml
streams:
  - url: "rtsp://user:password@<CAMERA_1_IP>:554/LiveChannel/0/media.smp"
    name: "CAMERA1"
  - url: "rtsp://user:password@<CAMERA_1_IP>:554/LiveChannel/1/media.smp"
    name: "CAMERA2"
  - url: "rtp://239.1.1.1:5004"
    name: "Multicast Feed A"
```

> **Note:** Include credentials in the URL (`user:password@`) for RTSP streams that require authentication. Without credentials, only liveness is checked (no jitter/FPS/bitrate).

### Alerts (optional)

Alerts can be embedded in `config.yaml` or kept in a separate `alerts.yaml`:

```yaml
# Embed in config.yaml (recommended)
streams:
  - url: "rtsp://user:password@<CAMERA_1_IP>:554/live"
    name: "CAMERA1"

alerts:
  enabled: true
  rules:
    loss_warn: 2.0       # Packet loss warning threshold (%)
    loss_crit: 10.0      # Packet loss critical threshold (%)
    jitter_warn: 50.0    # Jitter warning threshold (ms)
    jitter_crit: 100.0   # Jitter critical threshold (ms)
    min_bitrate: 10.0    # Minimum bitrate threshold (kbps)
    cooldown_secs: 60    # Minimum seconds between repeated alerts
  slack:
    - webhook_url: "https://hooks.slack.com/services/T00/B00/xxxxx"
      channel: "#stream-alerts"
      username: rtpulse
```

```bash
# Separate alerts file
./rtpulse -c config.yaml -A alerts.yaml
```

---

## Network Discovery

Auto-discover RTSP/RTP streams via packet capture (requires `libpcap-dev`):

```bash
# Install dependency
sudo apt install libpcap-dev   # Linux
brew install libpcap            # macOS

# Discover streams (saves to discovered.yaml)
sudo ./rtpulse discover -I eth0 -d 30

# Rename and use
mv discovered.yaml config.yaml
./rtpulse -c config.yaml
```

| Option | Description | Example |
|--------|-------------|---------|
| `-I`   | Network interface | `eth0` |
| `-d`   | Discovery duration (seconds) | `30` |
| `-p`   | RTSP port to watch | `554` |

---

## Keybindings

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Switch tab |
| `↑` / `↓` or `j` / `k` | Select stream |
| `r` | Restart monitoring |
| `p` | Pause / resume |
| `a` | Add stream |
| `d` | Delete selected stream |
| `/` | Cycle sort mode |
| `e` | Export stats to Excel (.xlsx) |
| `q` / `Ctrl+C` | Quit |

---

## Views

### Dashboard [1]
Health summary cards, aggregate metrics, and a list of problem streams.

### Overview [2]
All streams in a sortable table — Proto, Health, Bitrate, Loss%, Jitter, Latency, FPS, Uptime.

### Detail [3]
Sparkline charts for the selected stream: Bitrate, Jitter, Packet Loss, FPS.

### Logs [4]
Health transition events with timestamps.

### Stats [5]
SQLite-backed down-event statistics: today / 7-day / 30-day graphs, per-stream rollup, recent down timestamps. Press `e` to export to Excel.

---

## Health Thresholds

| Status | Conditions |
|--------|-----------|
| **Healthy** | Loss < 2% AND Jitter < 50ms AND Bitrate ≥ 10 kbps |
| **Degraded** | Loss 2–10% OR Jitter > 50ms OR Bitrate < 10 kbps |
| **Down** | Loss > 10% OR no response from server |

> FPS is displayed as a metric but is not used in health determination, as sub-streams may intentionally run at low frame rates.

---

## Architecture

```
src/
├── main.rs      # CLI parsing (clap), terminal setup, keyboard event loop
├── app.rs       # Application state, stream entries, health computation
├── monitor.rs   # Async RTSP probe tasks (DESCRIBE→SETUP→PLAY→collect→TEARDOWN)
├── batch.rs     # Epoll-based batch UDP receiver for RTP multicast (mio)
├── rtp.rs       # RTP header parser, SequenceTracker, JitterCalculator (RFC 3550)
├── rtsp.rs      # RTSP URL parser and request builder
├── capture.rs   # (feature: pcap-capture) Unified pcap-based monitoring
├── discover.rs  # (feature: pcap-capture) Network stream discovery
├── alert.rs     # AlertEngine — health transition → Slack/webhook dispatch
├── stats.rs     # SQLite persistence for down-event history
├── export.rs    # Excel (.xlsx) export via rust_xlsxwriter
└── ui.rs        # Ratatui rendering (five tabs, sparklines, dialogs)
```

**Data flow:** `main.rs` → `App` ← `MonitorHandle` (async metrics via mpsc channels)

---

## Build

```bash
cargo build                    # debug
cargo build --release          # optimized (LTO enabled)

# With pcap capture support (requires libpcap-dev)
cargo build --release --features pcap-capture

# Cross-compile for Linux musl (static binary)
cargo build --release --target x86_64-unknown-linux-musl
```

## Test & Lint

```bash
cargo test
cargo clippy
cargo fmt --check
```

---

## Dependencies

| Crate | Purpose |
|-------|---------|
| [ratatui](https://ratatui.rs/) | Terminal UI framework |
| [crossterm](https://github.com/crossterm-rs/crossterm) | Terminal manipulation |
| [tokio](https://tokio.rs/) | Async runtime |
| [mio](https://github.com/tokio-rs/mio) | Epoll-based UDP batch receiver |
| [clap](https://clap.rs/) | CLI argument parsing |
| [chrono](https://github.com/chronotope/chrono) | Time handling |
| [rusqlite](https://github.com/rusqlite/rusqlite) | SQLite stats persistence |
| [rust_xlsxwriter](https://github.com/jmcnamara/rust_xlsxwriter) | Excel export |
| [reqwest](https://github.com/seanmonstar/reqwest) | Slack/webhook HTTP dispatch |
| [serde](https://serde.rs/) | Config file serialization |
