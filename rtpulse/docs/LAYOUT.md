```
================================================================================
                     rtpulse  —  Layout & Architecture Reference
================================================================================


┌─── Tab 1: Dashboard (NEW — default view) ────────────────────────────────────┐
│                                                                              │
│  ┌─ Header ─────────────────────────────────────┬─ Tabs ─────────────────┐   │
│  │ ▶ rtpulse  ● 48  ▲ 3  ✖ 1  ? 0│ Dashboard  Ovw  Det  Log│  │
│  └──────────────────────────────────────────────┴────────────────────────┘   │
│                                                                              │
│  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐               │
│  │          ││          ││          ││          ││          │               │
│  │    52    ││    48    ││     3    ││     1    ││     0    │               │
│  │  TOTAL   ││ HEALTHY  ││ DEGRADED ││   DOWN   ││ UNKNOWN  │               │
│  │          ││          ││          ││          ││          │               │
│  └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘               │
│                                                                              │
│  ┌─────────────────┐┌─────────────────┐┌─────────────────┐┌───────────────┐ │
│  │  142.5 Mbps     ││  1.23%          ││  12.4 ms        ││ recv 84.2M    │ │
│  │  Total Bitrate  ││  Avg Loss       ││  Avg Jitter     ││ lost 1.0M     │ │
│  │                 ││  (max 28.5%)    ││  (max 98 ms)    ││ Packets       │ │
│  └─────────────────┘└─────────────────┘└─────────────────┘└───────────────┘ │
│                                                                              │
│  ┌─ ⚠ Problem Streams (4) ─────────────────────────────────────────────┐    │
│  │    Name                  Proto  Status    Bitrate   Loss%  Jitter FPS│    │
│  │ ── ───────────────────── ────── ───────── ──────── ────── ────── ─── │    │
│  │ ✖  camera-01.local/h264 RTSP   DOWN        42 kbps 28.5%  98 ms 6.1│    │
│  │ ▲  239.1.1.1            RTP    DEGRADED  1850 kbps 3.41% 32 ms 24.2│    │
│  │ ▲  warehouse-cam3       RTSP   DEGRADED  2100 kbps 2.80% 55 ms 22.0│    │
│  │ ▲  lobby-entrance       RTSP   DEGRADED  1920 kbps 4.10% 41 ms 19.8│    │
│  │                                                                       │    │
│  │  (only unhealthy streams shown — healthy streams hidden)              │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ▶ LIVE   q quit  ↑↓/jk select  Tab tab  a add  d del  r restart  p pause   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘


┌─── Tab 2: Overview (stream table — same as before) ──────────────────────────┐
│  ...full stream table with all streams...                                    │
└──────────────────────────────────────────────────────────────────────────────┘


┌─── Tab 3: Detail (sparklines — same as before) ─────────────────────────────┐
│  ...selected stream detail with sparkline charts...                          │
└──────────────────────────────────────────────────────────────────────────────┘


┌─── Tab 4: Logs (event log — same as before) ────────────────────────────────┐
│  ...event log with health transitions...                                     │
└──────────────────────────────────────────────────────────────────────────────┘



================================================================================
                          Layout Split (code mapping)
================================================================================

  Terminal Area
  ┌────────────────────────────────────────────────┐
  │  chunks[0]  Height: 3                          │  ← Header + Tabs
  ├────────────────────────────────────────────────┤
  │  chunks[1]  Height: Min(10)                    │  ← Main content
  │                                                │     app.tab switches:
  │  Tab::Dashboard → draw_dashboard               │
  │  Tab::Overview  → draw_overview  (Table)       │
  │  Tab::Detail    → draw_detail    (Sparklines)  │
  │  Tab::Logs      → draw_logs      (List)        │
  ├────────────────────────────────────────────────┤
  │  chunks[2]  Height: 1                          │  ← Status bar
  └────────────────────────────────────────────────┘

  Dashboard inner split:
  ┌────────────────────────────────────────────────┐
  │  [0] Height: 5  ── Health Cards (5x Horiz 20%)│
  │  ┌────┐┌────┐┌────┐┌────┐┌────┐               │
  │  │TOTL││HLTH││DEGD││DOWN││UNKN│               │
  │  └────┘└────┘└────┘└────┘└────┘               │
  ├────────────────────────────────────────────────┤
  │  [1] Height: 5  ── Aggregate Metrics (4x 25%) │
  │  ┌──────────┐┌──────────┐┌──────────┐┌──────┐ │
  │  │ Bitrate  ││ Avg Loss ││Avg Jitter││ Pkts │ │
  │  └──────────┘└──────────┘└──────────┘└──────┘ │
  ├────────────────────────────────────────────────┤
  │  [2] Min: 6  ── Problem Streams Table          │
  │  (filtered: only degraded + down)              │
  └────────────────────────────────────────────────┘

  Detail Tab inner split (unchanged):
  ┌────────────────────────────────────────────────┐
  │  [0] Height: 6     Stream Info                 │
  ├────────────────────────────────────────────────┤
  │  [1] Min: 8   Sparklines (4x Horiz 25%)       │
  │  ┌──────────┬──────────┬──────────┬──────────┐ │
  │  │ Bitrate  │ Jitter   │ Pkt Loss │ FPS      │ │
  │  └──────────┴──────────┴──────────┴──────────┘ │
  ├────────────────────────────────────────────────┤
  │  [2] Height: 5     Counters                    │
  └────────────────────────────────────────────────┘


================================================================================
                     Architecture (v2 — batch + alerts)
================================================================================

  ┌─ Config ──────────────────────────────────────────────────────────────────┐
  │  config.json                                                              │
  │  ├── streams: [{url, name}, ...]                                          │
  │  └── alerts:                                                              │
  │      ├── rules: {loss_warn, loss_crit, jitter_warn, ...}                  │
  │      ├── webhooks: [{url, headers}]                                       │
  │      └── slack: [{webhook_url, channel}]                                  │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─ Data Plane ──────────────────────────────────────────────────────────────┐
  │                                                                           │
  │   Option A: Simulation (default, for demo)                                │
  │   ┌─────────────────────────────────┐                                     │
  │   │  tokio tasks (1 per stream)     │──→ mpsc channel ──→ App state       │
  │   │  SimState with drift patterns   │                                     │
  │   └─────────────────────────────────┘                                     │
  │                                                                           │
  │   Option B: Real RTP (batch receiver)                                     │
  │   ┌─────────────────────────────────┐                                     │
  │   │  Dedicated OS thread            │                                     │
  │   │  mio::Poll (epoll)              │                                     │
  │   │  ┌─ UDP Socket 1 ─┐            │                                     │
  │   │  ├─ UDP Socket 2 ─┤            │──→ SharedMetricsMap ──→ App state   │
  │   │  ├─ UDP Socket 3 ─┤            │    (Arc<Mutex<HashMap>>)            │
  │   │  ├─ ...            │            │                                     │
  │   │  └─ UDP Socket N ─┘            │                                     │
  │   │                                 │                                     │
  │   │  Per-socket:                    │                                     │
  │   │  ├─ RtpHeader::parse()         │                                     │
  │   │  ├─ SequenceTracker (loss)     │                                     │
  │   │  └─ JitterCalculator (rfc3550) │                                     │
  │   └─────────────────────────────────┘                                     │
  │                                                                           │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌─ App State ───────────────────────────────────────────────────────────────┐
  │                                                                           │
  │   Vec<StreamEntry>                                                        │
  │   ├── id, url, name, protocol                                             │
  │   ├── health: Healthy | Degraded | Down | Unknown                         │
  │   └── metrics:                                                            │
  │       ├── bitrate_kbps, packet_loss_pct, jitter_ms, latency_ms, fps      │
  │       ├── packets_received, packets_lost, uptime_secs                     │
  │       └── *_history: VecDeque<f64> (120 points for sparklines)            │
  │                                                                           │
  │   On each tick:                                                           │
  │   ├── update_metrics() ← from monitors                                   │
  │   ├── health transition detection                                         │
  │   └── AlertEngine.evaluate() ← fires alerts on state change              │
  │                                                                           │
  └───────────────────────────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
  ┌─ TUI Renderer ─────────┐   ┌─ Alert Dispatcher ─────────────────────────┐
  │                         │   │                                             │
  │  ratatui + crossterm    │   │  tokio task (async)                         │
  │                         │   │                                             │
  │  Dashboard:             │   │  AlertEngine                                │
  │  ├─ Health cards (5)    │   │  ├── evaluate(stream) on health change      │
  │  ├─ Aggregate metrics   │   │  ├── cooldown per stream (configurable)     │
  │  └─ Problem streams     │   │  └── severity: Warning | Critical | Resolved│
  │                         │   │       │                                     │
  │  Overview:              │   │       ▼                                     │
  │  └─ Full stream table   │   │  mpsc channel                               │
  │                         │   │       │                                     │
  │  Detail:                │   │       ├──→ Webhook (reqwest POST JSON)      │
  │  ├─ Stream info         │   │       │   {stream_id, severity, metrics}    │
  │  ├─ 4x Sparklines      │   │       │                                     │
  │  └─ Counters            │   │       └──→ Slack (incoming webhook)         │
  │                         │   │           attachment with color-coded fields │
  │  Logs:                  │   │                                             │
  │  └─ Event log (500)     │   └─────────────────────────────────────────────┘
  │                         │
  └─────────────────────────┘


================================================================================
                  Batch Receiver vs Per-Task (scalability)
================================================================================

  Per-Task Model (current simulation):
  ┌────────────────────────────────────────┐
  │  Stream 1  →  tokio::task  →  mpsc    │     Good for: < 50 streams
  │  Stream 2  →  tokio::task  →  mpsc    │     Simple, easy to reason about
  │  Stream 3  →  tokio::task  →  mpsc    │     Each task: ~8KB stack
  │  ...                                   │     50 tasks ≈ 400KB overhead
  │  Stream N  →  tokio::task  →  mpsc    │
  └────────────────────────────────────────┘

  Batch Receiver Model (batch.rs):
  ┌────────────────────────────────────────┐
  │                                        │     Good for: 50 ~ 1000+ streams
  │  Socket 1 ──┐                          │     Single OS thread
  │  Socket 2 ──┤                          │     epoll multiplexing
  │  Socket 3 ──┼──→ mio::Poll ──→ one    │     O(1) per ready socket
  │  ...        │     (epoll)      thread  │     Minimal context switching
  │  Socket N ──┘         │                │
  │                       ▼                │
  │              SharedMetricsMap          │
  │              (Arc<Mutex<HashMap>>)     │
  │                       │                │
  │                       ▼                │
  │                App reads on tick       │
  │                                        │
  └────────────────────────────────────────┘

  Memory comparison (500 streams):
  ┌──────────────────────┬───────────┬─────────────┐
  │                      │ Per-Task  │ Batch       │
  ├──────────────────────┼───────────┼─────────────┤
  │ Threads              │ 1 (tokio) │ 1 (OS)      │
  │ Tasks/goroutines     │ 500       │ 0            │
  │ Syscalls per tick    │ 500 recv  │ 1 epoll_wait │
  │ Context switches     │ ~500/sec  │ ~1/sec       │
  │ Overhead             │ ~4 MB     │ ~200 KB      │
  └──────────────────────┴───────────┴─────────────┘

================================================================================
```
