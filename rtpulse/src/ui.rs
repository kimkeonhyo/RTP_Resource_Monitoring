use crate::app::{App, AppTab, StatsRow, StreamHealth, StreamProtocol};
use crate::stats::{ConnectionEventKind, StatsFilter};
use chrono::{Local, TimeZone};
use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{
        Block, Borders, Cell, Clear, List, ListItem, Paragraph, Row, Sparkline, Table, Tabs, Wrap,
    },
};

// Color palette
const C_HEALTHY: Color = Color::Green;
const C_DEGRADED: Color = Color::Yellow;
const C_DOWN: Color = Color::Red;
const C_UNKNOWN: Color = Color::DarkGray;
const C_ACCENT: Color = Color::Cyan;
const C_DIM: Color = Color::DarkGray;
const C_HEADER_BG: Color = Color::Rgb(30, 30, 50);
const C_SELECTED_BG: Color = Color::Rgb(40, 40, 70);

fn health_color(h: StreamHealth) -> Color {
    match h {
        StreamHealth::Healthy => C_HEALTHY,
        StreamHealth::Degraded => C_DEGRADED,
        StreamHealth::Down => C_DOWN,
        StreamHealth::Unknown => C_UNKNOWN,
    }
}

pub fn draw(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // header + tabs
            Constraint::Min(10),   // main content
            Constraint::Length(1), // status bar
        ])
        .split(f.area());

    draw_header(f, app, chunks[0]);

    match app.tab {
        AppTab::Dashboard => draw_dashboard(f, app, chunks[1]),
        AppTab::Overview => draw_overview(f, app, chunks[1]),
        AppTab::Detail => draw_detail(f, app, chunks[1]),
        AppTab::Logs => draw_logs(f, app, chunks[1]),
        AppTab::Stats => draw_stats(f, app, chunks[1]),
    }

    draw_status_bar(f, app, chunks[2]);

    // Add dialog overlay
    if app.show_add_dialog {
        draw_add_dialog(f, app);
    }
}

fn draw_header(f: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Min(30), Constraint::Length(66)])
        .split(area);

    // Title + summary
    let (healthy, degraded, down, unknown): (usize, usize, usize, usize) = app.summary();
    let title = Line::from(vec![
        Span::styled(
            " ▶ rtpulse ",
            Style::default().fg(C_ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(format!("● {healthy}"), Style::default().fg(C_HEALTHY)),
        Span::raw("  "),
        Span::styled(format!("▲ {degraded}"), Style::default().fg(C_DEGRADED)),
        Span::raw("  "),
        Span::styled(format!("✖ {down}"), Style::default().fg(C_DOWN)),
        Span::raw("  "),
        Span::styled(format!("? {unknown}"), Style::default().fg(C_UNKNOWN)),
    ]);
    let title_block = Paragraph::new(title).block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(C_DIM)),
    );
    f.render_widget(title_block, chunks[0]);

    // Tabs
    let tab_titles: Vec<Line> = AppTab::titles()
        .iter()
        .map(|t| Line::from(Span::raw(*t)))
        .collect();
    let tab_index = match app.tab {
        AppTab::Dashboard => 0,
        AppTab::Overview => 1,
        AppTab::Detail => 2,
        AppTab::Logs => 3,
        AppTab::Stats => 4,
    };
    let tabs = Tabs::new(tab_titles)
        .select(tab_index)
        .style(Style::default().fg(Color::White))
        .highlight_style(Style::default().fg(C_ACCENT).add_modifier(Modifier::BOLD))
        .divider("│")
        .block(
            Block::default()
                .borders(Borders::BOTTOM)
                .border_style(Style::default().fg(C_DIM)),
        );
    f.render_widget(tabs, chunks[1]);
}

fn draw_dashboard(f: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(5), // health cards
            Constraint::Length(5), // aggregate metrics
            Constraint::Min(6),    // problem streams
        ])
        .split(area);

    // ── Health status cards ──
    let (healthy, degraded, down, unknown) = app.summary();
    let total = app.streams.len();
    let card_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(20),
            Constraint::Percentage(20),
            Constraint::Percentage(20),
            Constraint::Percentage(20),
            Constraint::Percentage(20),
        ])
        .split(chunks[0]);

    let total_str = total.to_string();
    let healthy_str = healthy.to_string();
    let degraded_str = degraded.to_string();
    let down_str = down.to_string();
    let unknown_str = unknown.to_string();
    let total_card = big_number_card("TOTAL", &total_str, C_ACCENT);
    let healthy_card = big_number_card("HEALTHY", &healthy_str, C_HEALTHY);
    let degraded_card = big_number_card("DEGRADED", &degraded_str, C_DEGRADED);
    let down_card = big_number_card("DOWN", &down_str, C_DOWN);
    let unknown_card = big_number_card("UNKNOWN", &unknown_str, C_UNKNOWN);

    f.render_widget(total_card, card_chunks[0]);
    f.render_widget(healthy_card, card_chunks[1]);
    f.render_widget(degraded_card, card_chunks[2]);
    f.render_widget(down_card, card_chunks[3]);
    f.render_widget(unknown_card, card_chunks[4]);

    // ── Aggregate metrics ──
    let agg = app.aggregate_metrics();
    let metrics_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
        ])
        .split(chunks[1]);

    let bitrate_str = format!("{:.1} Mbps", agg.total_bitrate_kbps / 1000.0);
    let loss_str = format!("{:.2}%  (max {:.1}%)", agg.avg_loss_pct, agg.max_loss_pct);
    let jitter_str = format!(
        "{:.1} ms  (max {:.0} ms)",
        agg.avg_jitter_ms, agg.max_jitter_ms
    );
    let pkts_str = format!(
        "recv {} / lost {}",
        format_number(agg.total_pkts_recv),
        format_number(agg.total_pkts_lost)
    );
    let bitrate_card = metric_card("Total Bitrate", &bitrate_str, C_ACCENT);
    let loss_card = metric_card(
        "Avg Loss",
        &loss_str,
        if agg.avg_loss_pct > 5.0 {
            C_DOWN
        } else if agg.avg_loss_pct > 1.0 {
            C_DEGRADED
        } else {
            C_HEALTHY
        },
    );
    let jitter_card = metric_card(
        "Avg Jitter",
        &jitter_str,
        if agg.avg_jitter_ms > 50.0 {
            C_DOWN
        } else if agg.avg_jitter_ms > 20.0 {
            C_DEGRADED
        } else {
            C_HEALTHY
        },
    );
    let pkts_card = metric_card("Packets", &pkts_str, Color::White);

    f.render_widget(bitrate_card, metrics_chunks[0]);
    f.render_widget(loss_card, metrics_chunks[1]);
    f.render_widget(jitter_card, metrics_chunks[2]);
    f.render_widget(pkts_card, metrics_chunks[3]);

    // ── Problem streams (non-healthy only) ──
    let problems = app.problem_streams();

    if problems.is_empty() {
        let msg = Paragraph::new(Line::from(vec![
            Span::styled(
                "  ✓ ",
                Style::default().fg(C_HEALTHY).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "All streams healthy — no issues detected",
                Style::default().fg(C_HEALTHY),
            ),
        ]))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_DIM))
                .title(" Problem Streams "),
        );
        f.render_widget(msg, chunks[2]);
    } else {
        let header_cells = [
            "", "Name", "Proto", "Status", "Bitrate", "Loss", "Jitter", "FPS",
        ]
        .iter()
        .map(|h| Cell::from(*h).style(Style::default().fg(C_ACCENT).add_modifier(Modifier::BOLD)));
        let header = Row::new(header_cells)
            .style(Style::default().bg(C_HEADER_BG))
            .height(1);

        let rows: Vec<Row> = problems
            .iter()
            .map(|s| {
                let hc = health_color(s.health);
                Row::new(vec![
                    Cell::from(s.health.symbol()).style(Style::default().fg(hc)),
                    Cell::from(s.name.as_str()),
                    Cell::from(match s.protocol {
                        StreamProtocol::Rtp => "RTP",
                        StreamProtocol::Rtsp => "RTSP",
                    }),
                    Cell::from(s.health.label()).style(Style::default().fg(hc)),
                    Cell::from(format!("{:.0} kbps", s.metrics.bitrate_kbps)),
                    Cell::from(format!("{:.2}%", s.metrics.packet_loss_pct)).style(
                        Style::default().fg(if s.metrics.packet_loss_pct > 5.0 {
                            C_DOWN
                        } else {
                            C_DEGRADED
                        }),
                    ),
                    Cell::from(format!("{:.1} ms", s.metrics.jitter_ms)),
                    Cell::from(format!("{:.1}", s.metrics.fps)),
                ])
            })
            .collect();

        let table = Table::new(
            rows,
            [
                Constraint::Length(2),
                Constraint::Min(20),
                Constraint::Length(6),
                Constraint::Length(10),
                Constraint::Length(12),
                Constraint::Length(9),
                Constraint::Length(10),
                Constraint::Length(6),
            ],
        )
        .header(header)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_DOWN))
                .title(format!(" ⚠ Problem Streams ({}) ", problems.len())),
        );

        f.render_widget(table, chunks[2]);
    }
}

fn big_number_card<'a>(label: &'a str, value: &'a str, color: Color) -> Paragraph<'a> {
    let text = vec![
        Line::from(Span::styled(
            format!("  {value}"),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            format!("  {label}"),
            Style::default().fg(C_DIM),
        )),
    ];
    Paragraph::new(text).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_DIM)),
    )
}

fn metric_card<'a>(label: &'a str, value: &'a str, color: Color) -> Paragraph<'a> {
    let text = vec![
        Line::from(Span::styled(
            format!("  {value}"),
            Style::default().fg(color),
        )),
        Line::from(Span::styled(
            format!("  {label}"),
            Style::default().fg(C_DIM),
        )),
    ];
    Paragraph::new(text).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_DIM)),
    )
}

fn draw_overview(f: &mut Frame, app: &App, area: Rect) {
    let header_cells = [
        "", "Name", "Proto", "Health", "Bitrate", "Loss %", "Jitter", "Latency", "FPS", "Uptime",
    ]
    .iter()
    .map(|h| Cell::from(*h).style(Style::default().fg(C_ACCENT).add_modifier(Modifier::BOLD)));
    let header = Row::new(header_cells)
        .style(Style::default().bg(C_HEADER_BG))
        .height(1);

    let sorted = app.sorted_stream_indices();
    let rows: Vec<Row> = sorted
        .iter()
        .map(|&real_idx| {
            let s = &app.streams[real_idx];
            let hc = health_color(s.health);
            let is_selected = real_idx == app.selected;

            let style = if is_selected {
                Style::default()
                    .bg(C_SELECTED_BG)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };

            let uptime = format_duration(s.metrics.uptime_secs);

            Row::new(vec![
                Cell::from(s.health.symbol()).style(Style::default().fg(hc)),
                Cell::from(s.name.as_str()),
                Cell::from(match s.protocol {
                    StreamProtocol::Rtp => "RTP",
                    StreamProtocol::Rtsp => "RTSP",
                }),
                Cell::from(s.health.label()).style(Style::default().fg(hc)),
                Cell::from(format!("{:.0} kbps", s.metrics.bitrate_kbps)),
                Cell::from(format!("{:.2}%", s.metrics.packet_loss_pct)).style(
                    Style::default().fg(if s.metrics.packet_loss_pct > 5.0 {
                        C_DOWN
                    } else if s.metrics.packet_loss_pct > 1.0 {
                        C_DEGRADED
                    } else {
                        Color::White
                    }),
                ),
                Cell::from(format!("{:.1} ms", s.metrics.jitter_ms)).style(Style::default().fg(
                    if s.metrics.jitter_ms > 50.0 {
                        C_DOWN
                    } else if s.metrics.jitter_ms > 20.0 {
                        C_DEGRADED
                    } else {
                        Color::White
                    },
                )),
                Cell::from(format!("{:.0} ms", s.metrics.latency_ms)),
                Cell::from(format!("{:.1}", s.metrics.fps)),
                Cell::from(uptime),
            ])
            .style(style)
            .height(1)
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Length(2),  // icon
            Constraint::Min(20),    // name
            Constraint::Length(6),  // proto
            Constraint::Length(10), // health
            Constraint::Length(12), // bitrate
            Constraint::Length(9),  // loss
            Constraint::Length(10), // jitter
            Constraint::Length(10), // latency
            Constraint::Length(6),  // fps
            Constraint::Length(10), // uptime
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_DIM))
            .title(format!(
                " Streams ({}) — Sort: {} ",
                app.streams.len(),
                app.sort_mode.label()
            )),
    );

    f.render_widget(table, area);
}

fn draw_detail(f: &mut Frame, app: &App, area: Rect) {
    let Some(stream) = app.selected_stream() else {
        let msg = Paragraph::new("No stream selected")
            .block(Block::default().borders(Borders::ALL).title(" Detail "));
        f.render_widget(msg, area);
        return;
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(6), // stream info
            Constraint::Min(8),    // sparklines
            Constraint::Length(5), // raw counters
        ])
        .split(area);

    // --- Stream info ---
    let hc = health_color(stream.health);
    let info = vec![
        Line::from(vec![
            Span::styled(
                format!(" {} ", stream.health.symbol()),
                Style::default().fg(hc).add_modifier(Modifier::BOLD),
            ),
            Span::styled(&stream.name, Style::default().add_modifier(Modifier::BOLD)),
            Span::raw("  "),
            Span::styled(stream.health.label(), Style::default().fg(hc)),
        ]),
        Line::from(vec![
            Span::styled("  URL: ", Style::default().fg(C_DIM)),
            Span::raw(&stream.url),
        ]),
        Line::from(vec![
            Span::styled("  Protocol: ", Style::default().fg(C_DIM)),
            Span::raw(stream.protocol.to_string()),
            Span::raw("    "),
            Span::styled("Uptime: ", Style::default().fg(C_DIM)),
            Span::raw(format_duration(stream.metrics.uptime_secs)),
            Span::raw("    "),
            Span::styled("Last update: ", Style::default().fg(C_DIM)),
            Span::raw(stream.metrics.last_update.format("%H:%M:%S").to_string()),
        ]),
    ];
    let info_block = Paragraph::new(info).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_DIM))
            .title(" Stream Detail "),
    );
    f.render_widget(info_block, chunks[0]);

    // --- Sparklines ---
    let spark_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
        ])
        .split(chunks[1]);

    draw_sparkline(
        f,
        &stream.metrics.bitrate_history,
        "Bitrate (kbps)",
        C_ACCENT,
        spark_chunks[0],
    );
    draw_sparkline(
        f,
        &stream.metrics.jitter_history,
        "Jitter (ms)",
        C_DEGRADED,
        spark_chunks[1],
    );
    draw_sparkline(
        f,
        &stream.metrics.loss_history,
        "Pkt Loss (%)",
        C_DOWN,
        spark_chunks[2],
    );
    draw_sparkline(
        f,
        &stream.metrics.fps_history,
        "FPS",
        C_HEALTHY,
        spark_chunks[3],
    );

    // --- Raw counters ---
    let counters = vec![
        Line::from(vec![
            Span::styled("  Packets Recv: ", Style::default().fg(C_DIM)),
            Span::raw(format_number(stream.metrics.packets_received)),
            Span::raw("    "),
            Span::styled("Packets Lost: ", Style::default().fg(C_DIM)),
            Span::styled(
                format_number(stream.metrics.packets_lost),
                Style::default().fg(if stream.metrics.packets_lost > 0 {
                    C_DOWN
                } else {
                    Color::White
                }),
            ),
            Span::raw("    "),
            Span::styled("Current Bitrate: ", Style::default().fg(C_DIM)),
            Span::raw(format!("{:.0} kbps", stream.metrics.bitrate_kbps)),
        ]),
        Line::from(vec![
            Span::styled("  Jitter: ", Style::default().fg(C_DIM)),
            Span::raw(format!("{:.2} ms", stream.metrics.jitter_ms)),
            Span::raw("    "),
            Span::styled("Latency: ", Style::default().fg(C_DIM)),
            Span::raw(format!("{:.0} ms", stream.metrics.latency_ms)),
            Span::raw("    "),
            Span::styled("FPS: ", Style::default().fg(C_DIM)),
            Span::raw(format!("{:.1}", stream.metrics.fps)),
        ]),
    ];
    let counters_block = Paragraph::new(counters).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_DIM))
            .title(" Counters "),
    );
    f.render_widget(counters_block, chunks[2]);
}

fn draw_sparkline(
    f: &mut Frame,
    data: &std::collections::VecDeque<f64>,
    title: &str,
    color: Color,
    area: Rect,
) {
    let data_vec: Vec<u64> = data.iter().map(|v| v.max(0.0) as u64).collect();
    let current = data.back().map(|v| format!("{v:.1}")).unwrap_or_default();

    let spark = Sparkline::default()
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_DIM))
                .title(format!(" {title}: {current} ")),
        )
        .data(&data_vec)
        .style(Style::default().fg(color));

    f.render_widget(spark, area);
}

fn draw_logs(f: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app
        .logs
        .iter()
        .rev()
        .take(area.height as usize - 2)
        .map(|log: &String| {
            let style = if log.contains("DOWN") || log.contains("Removed") {
                Style::default().fg(C_DOWN)
            } else if log.contains("DEGRADED") {
                Style::default().fg(C_DEGRADED)
            } else if log.contains("HEALTHY") || log.contains("Added") || log.contains("RESUMED") {
                Style::default().fg(C_HEALTHY)
            } else {
                Style::default().fg(C_DIM)
            };
            ListItem::new(Line::from(Span::styled(log.as_str(), style)))
        })
        .collect();

    let list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_DIM))
            .title(format!(" Event Log ({} entries) ", app.logs.len())),
    );
    f.render_widget(list, area);
}

fn draw_stats(f: &mut Frame, app: &App, area: Rect) {
    if let Some(error) = &app.stats_view.error {
        let msg = Paragraph::new(error.as_str()).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_DOWN))
                .title(" Stats "),
        );
        f.render_widget(msg, area);
        return;
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(5),
            Constraint::Length(9),
            Constraint::Min(8),
        ])
        .split(area);

    // Filter tab row (1D / 7D / 15D / 30D)
    let filter_tabs: Vec<Line> = [
        StatsFilter::Day1,
        StatsFilter::Day7,
        StatsFilter::Day15,
        StatsFilter::Day30,
    ]
    .iter()
    .map(|&f| {
        let label = format!(" {} ", f.label());
        if f == app.stats_filter {
            Line::from(Span::styled(
                label,
                Style::default()
                    .fg(Color::Black)
                    .bg(C_ACCENT)
                    .add_modifier(Modifier::BOLD),
            ))
        } else {
            Line::from(Span::styled(label, Style::default().fg(C_ACCENT)))
        }
    })
    .collect();

    let filter_bar = Tabs::new(filter_tabs)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_DIM))
                .title(" Filter [f] "),
        )
        .select(match app.stats_filter {
            StatsFilter::Day1 => 0,
            StatsFilter::Day7 => 1,
            StatsFilter::Day15 => 2,
            StatsFilter::Day30 => 3,
        })
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(C_ACCENT)
                .add_modifier(Modifier::BOLD),
        );
    f.render_widget(filter_bar, chunks[0]);

    // Summary cards — aggregated from filter period
    let total_reconnects: usize = app.stats_view.rows.iter().map(|r| r.reconnect_count).sum();
    let total_warnings: usize = app.stats_view.rows.iter().map(|r| r.warn_count).sum();
    let total_downs: usize = app.stats_view.rows.iter().map(|r| r.down_count).sum();
    let last_event_epoch = app
        .stats_view
        .rows
        .iter()
        .filter_map(|r| r.last_event_epoch)
        .max();

    let filter_label = app.stats_filter.label();
    let card_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
        ])
        .split(chunks[1]);

    f.render_widget(
        big_number_card(
            &format!("RECONNECT ({})", filter_label),
            &total_reconnects.to_string(),
            C_HEALTHY,
        ),
        card_chunks[0],
    );
    f.render_widget(
        big_number_card(
            &format!("WARNING ({})", filter_label),
            &total_warnings.to_string(),
            C_DEGRADED,
        ),
        card_chunks[1],
    );
    f.render_widget(
        big_number_card(
            &format!("DOWN ({})", filter_label),
            &total_downs.to_string(),
            C_DOWN,
        ),
        card_chunks[2],
    );
    f.render_widget(
        metric_card(
            "Last Event",
            &format_last_down(last_event_epoch),
            Color::White,
        ),
        card_chunks[3],
    );

    // Filtered trend chart
    let trend_title = format!(" {} – All Events ", app.stats_filter.label());
    draw_stats_chart(
        f,
        &trend_title,
        &app.stats_view.filter_trend.values,
        C_ACCENT,
        chunks[2],
    );

    // Bottom: stream rollup table + event log
    let bottom_chunks = if chunks[3].width >= 120 {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
            .split(chunks[3])
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
            .split(chunks[3])
    };

    let selected_id = app.selected_stream().map(|stream| stream.id);
    draw_stats_table(
        f,
        &app.stats_view.rows,
        selected_id,
        &format!(" Stream Events ({}) ", app.stats_filter.label()),
        bottom_chunks[0],
    );
    draw_event_log(f, app, bottom_chunks[1]);
}

fn draw_stats_table(
    f: &mut Frame,
    rows: &[StatsRow],
    selected_id: Option<usize>,
    title: &str,
    area: Rect,
) {
    let header_cells = ["Name", "Down", "Warn", "Recon", "Last Event"]
        .iter()
        .map(|h| Cell::from(*h).style(Style::default().fg(C_ACCENT).add_modifier(Modifier::BOLD)));
    let header = Row::new(header_cells)
        .style(Style::default().bg(C_HEADER_BG))
        .height(1);

    let table_rows: Vec<Row> = rows
        .iter()
        .map(|row| {
            let style = if Some(row.stream_id) == selected_id {
                Style::default()
                    .bg(C_SELECTED_BG)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };

            Row::new(vec![
                Cell::from(row.stream_name.as_str()),
                Cell::from(row.down_count.to_string()).style(Style::default().fg(
                    if row.down_count > 0 {
                        C_DOWN
                    } else {
                        Color::White
                    },
                )),
                Cell::from(row.warn_count.to_string()).style(Style::default().fg(
                    if row.warn_count > 0 {
                        C_DEGRADED
                    } else {
                        Color::White
                    },
                )),
                Cell::from(row.reconnect_count.to_string()).style(Style::default().fg(
                    if row.reconnect_count > 0 {
                        C_HEALTHY
                    } else {
                        Color::White
                    },
                )),
                Cell::from(format_last_down(row.last_event_epoch)),
            ])
            .style(style)
        })
        .collect();

    let table = Table::new(
        table_rows,
        [
            Constraint::Min(18),
            Constraint::Length(6),
            Constraint::Length(6),
            Constraint::Length(7),
            Constraint::Length(18),
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_DIM))
            .title(title),
    );

    f.render_widget(table, area);
}

fn draw_event_log(f: &mut Frame, app: &App, area: Rect) {
    let title = format!(" Event Log ({}) ", app.stats_filter.label());

    let items: Vec<ListItem> = if app.stats_view.event_log.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "No events recorded in this period",
            Style::default().fg(C_DIM),
        )))]
    } else {
        app.stats_view
            .event_log
            .iter()
            .map(|entry| {
                let timestamp = format_timeline_time(entry.happened_at_epoch);
                let kind_color = match entry.event_kind {
                    ConnectionEventKind::Down => C_DOWN,
                    ConnectionEventKind::Warning => C_DEGRADED,
                    ConnectionEventKind::Reconnect => C_HEALTHY,
                };
                let kind_label = format!("{:<9}", entry.event_kind.label());
                let name_width = 16usize;
                let name = if entry.stream_name.len() > name_width {
                    format!("{:.width$}", entry.stream_name, width = name_width)
                } else {
                    format!("{:<width$}", entry.stream_name, width = name_width)
                };
                ListItem::new(Line::from(vec![
                    Span::styled(format!("{timestamp}  "), Style::default().fg(C_DIM)),
                    Span::styled(format!("{name}  "), Style::default().fg(Color::White)),
                    Span::styled(
                        kind_label,
                        Style::default().fg(kind_color).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(format!("  {}", entry.cause()), Style::default().fg(C_DIM)),
                ]))
            })
            .collect()
    };

    let list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_DIM))
            .title(title),
    );
    f.render_widget(list, area);
}

fn draw_stats_chart(f: &mut Frame, title: &str, values: &[u64], color: Color, area: Rect) {
    let total: u64 = values.iter().sum();
    let chart = Sparkline::default()
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_DIM))
                .title(format!("{title} total:{total} ")),
        )
        .data(values)
        .style(Style::default().fg(color));
    f.render_widget(chart, area);
}

fn draw_status_bar(f: &mut Frame, app: &App, area: Rect) {
    let pause_indicator = if app.paused {
        Span::styled(
            " ⏸ PAUSED ",
            Style::default().fg(Color::Black).bg(C_DEGRADED),
        )
    } else {
        Span::styled(" ▶ LIVE ", Style::default().fg(Color::Black).bg(C_HEALTHY))
    };

    let help = Line::from(vec![
        pause_indicator,
        Span::raw("  "),
        Span::styled("q", Style::default().fg(C_ACCENT)),
        Span::raw(" quit  "),
        Span::styled("↑↓/jk", Style::default().fg(C_ACCENT)),
        Span::raw(" select  "),
        Span::styled("Tab", Style::default().fg(C_ACCENT)),
        Span::raw(" tab  "),
        Span::styled("a", Style::default().fg(C_ACCENT)),
        Span::raw(" add  "),
        Span::styled("d", Style::default().fg(C_ACCENT)),
        Span::raw(" delete  "),
        Span::styled("r", Style::default().fg(C_ACCENT)),
        Span::raw(" restart  "),
        Span::styled("p", Style::default().fg(C_ACCENT)),
        Span::raw(" pause  "),
        Span::styled("/", Style::default().fg(C_ACCENT)),
        Span::raw(format!(" sort:{}  ", app.sort_mode.label())),
        Span::styled("e", Style::default().fg(C_ACCENT)),
        Span::raw(" export"),
    ]);
    f.render_widget(Paragraph::new(help), area);
}

fn draw_add_dialog(f: &mut Frame, app: &App) {
    let area = f.area();
    let dialog_w = 60.min(area.width - 4);
    let dialog_h = 5;
    let x = (area.width.saturating_sub(dialog_w)) / 2;
    let y = (area.height.saturating_sub(dialog_h)) / 2;
    let dialog_area = Rect::new(x, y, dialog_w, dialog_h);

    f.render_widget(Clear, dialog_area);

    let input = Paragraph::new(Line::from(vec![
        Span::styled(" URL: ", Style::default().fg(C_ACCENT)),
        Span::raw(&app.input_buffer),
        Span::styled("█", Style::default().fg(Color::White)),
    ]))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_ACCENT))
            .title(" Add Stream (Enter to confirm, Esc to cancel) "),
    )
    .wrap(Wrap { trim: false });

    f.render_widget(input, dialog_area);
}

fn format_duration(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}h{m:02}m{s:02}s")
    } else if m > 0 {
        format!("{m}m{s:02}s")
    } else {
        format!("{s}s")
    }
}

fn format_number(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}K", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn format_last_down(epoch: Option<i64>) -> String {
    epoch
        .map(format_short_time)
        .unwrap_or_else(|| "Never".to_string())
}

fn format_timeline_time(epoch: i64) -> String {
    local_time(epoch)
        .map(|dt| dt.format("%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "invalid time".to_string())
}

fn format_short_time(epoch: i64) -> String {
    local_time(epoch)
        .map(|dt| dt.format("%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "invalid time".to_string())
}

fn local_time(epoch: i64) -> Option<chrono::DateTime<Local>> {
    Local
        .timestamp_opt(epoch, 0)
        .single()
        .or_else(|| Local.timestamp_opt(epoch, 0).earliest())
        .or_else(|| Local.timestamp_opt(epoch, 0).latest())
}
