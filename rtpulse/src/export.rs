//! Excel (xlsx) export for rtpulse stats.
//!
//! Produces a timestamped `.xlsx` file with six sheets:
//!   1. Summary        – global down counts + last-down time
//!   2. Stream Stats   – per-stream today / 7d / 30d downs + last-down
//!   3. Today (Hourly) – 24 hourly down-event buckets
//!   4. Last 7 Days    – 7 daily down-event buckets
//!   5. Last 30 Days   – 30 daily down-event buckets
//!   6. Event Log      – every raw connection event in the DB

use crate::app::{StatsRow, StatsView, StreamEntry};
use crate::stats::{RawConnectionEvent, StatsStore};
use anyhow::Result;
use chrono::{Duration, Local, TimeZone};
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook, Worksheet};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Build and write the xlsx file. Returns the output filename on success.
pub fn export_xlsx(
    stats_view: &StatsView,
    streams: &[StreamEntry],
    store: &StatsStore,
) -> Result<String> {
    let now = Local::now();
    let filename = format!("rtpulse_export_{}.xlsx", now.format("%Y%m%d_%H%M%S"));

    let mut wb = Workbook::new();

    write_summary_sheet(&mut wb, stats_view, streams)?;
    write_stream_stats_sheet(&mut wb, &stats_view.rows, streams)?;
    write_hourly_sheet(&mut wb, stats_view)?;
    write_weekly_sheet(&mut wb, stats_view)?;
    write_monthly_sheet(&mut wb, stats_view)?;

    let raw_events = store.read_all_events()?;
    write_event_log_sheet(&mut wb, &raw_events)?;

    wb.save(&filename)?;
    Ok(filename)
}

// ---------------------------------------------------------------------------
// Shared formats
// ---------------------------------------------------------------------------

fn header_fmt() -> Format {
    Format::new()
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_border_bottom(FormatBorder::Thin)
        .set_background_color(0x2D2D2D)
        .set_font_color(0xF8F8F2)
}

fn label_fmt() -> Format {
    Format::new().set_bold()
}

fn center_fmt() -> Format {
    Format::new().set_align(FormatAlign::Center)
}

// ---------------------------------------------------------------------------
// Sheet 1: Summary
// ---------------------------------------------------------------------------

fn write_summary_sheet(
    wb: &mut Workbook,
    view: &StatsView,
    streams: &[StreamEntry],
) -> Result<()> {
    let ws = wb.add_worksheet();
    ws.set_name("Summary")?;
    ws.set_column_width(0, 24)?;
    ws.set_column_width(1, 30)?;

    let h = header_fmt();
    let l = label_fmt();

    ws.write_with_format(0, 0, "Metric", &h)?;
    ws.write_with_format(0, 1, "Value", &h)?;

    let now = Local::now();
    let rows: &[(&str, String)] = &[
        ("Export Generated", now.format("%Y-%m-%d %H:%M:%S").to_string()),
        ("Total Streams", streams.len().to_string()),
        ("Downs Today", view.summary.downs_today.to_string()),
        ("Downs Last 7 Days", view.summary.downs_last_7d.to_string()),
        ("Downs Last 30 Days", view.summary.downs_last_30d.to_string()),
        (
            "Last Down At",
            view.summary
                .last_down_epoch
                .map(epoch_to_string)
                .unwrap_or_else(|| "–".to_string()),
        ),
    ];

    for (i, (key, val)) in rows.iter().enumerate() {
        let row = (i + 1) as u32;
        ws.write_with_format(row, 0, *key, &l)?;
        ws.write(row, 1, val.as_str())?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Sheet 2: Stream Stats
// ---------------------------------------------------------------------------

fn write_stream_stats_sheet(
    wb: &mut Workbook,
    rows: &[StatsRow],
    streams: &[StreamEntry],
) -> Result<()> {
    let ws = wb.add_worksheet();
    ws.set_name("Stream Stats")?;
    ws.set_column_width(0, 28)?;
    ws.set_column_width(1, 45)?;
    ws.set_column_width(2, 14)?;
    ws.set_column_width(3, 12)?;
    ws.set_column_width(4, 14)?;
    ws.set_column_width(5, 22)?;

    let h = header_fmt();
    let c = center_fmt();

    ws.write_with_format(0, 0, "Stream Name", &h)?;
    ws.write_with_format(0, 1, "URL", &h)?;
    ws.write_with_format(0, 2, "Downs", &h)?;
    ws.write_with_format(0, 3, "Warnings", &h)?;
    ws.write_with_format(0, 4, "Reconnects", &h)?;
    ws.write_with_format(0, 5, "Last Event", &h)?;

    // Build id→url map for URL lookup
    let url_map: std::collections::HashMap<usize, &str> = streams
        .iter()
        .map(|s| (s.id, s.url.as_str()))
        .collect();

    for (i, row) in rows.iter().enumerate() {
        let r = (i + 1) as u32;
        let url = url_map.get(&row.stream_id).copied().unwrap_or("(removed)");
        let last_down = row
            .last_event_epoch
            .map(epoch_to_string)
            .unwrap_or_else(|| "–".to_string());

        ws.write(r, 0, row.stream_name.as_str())?;
        ws.write(r, 1, url)?;
        ws.write_with_format(r, 2, row.down_count as u64, &c)?;
        ws.write_with_format(r, 3, row.warn_count as u64, &c)?;
        ws.write_with_format(r, 4, row.reconnect_count as u64, &c)?;
        ws.write(r, 5, last_down.as_str())?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Sheet 3: Today (Hourly)
// ---------------------------------------------------------------------------

fn write_hourly_sheet(wb: &mut Workbook, view: &StatsView) -> Result<()> {
    let ws = wb.add_worksheet();
    ws.set_name("Today (Hourly)")?;
    ws.set_column_width(0, 10)?;
    ws.set_column_width(1, 14)?;

    let h = header_fmt();
    let c = center_fmt();

    ws.write_with_format(0, 0, "Hour", &h)?;
    ws.write_with_format(0, 1, "Down Events", &h)?;

    for (i, &val) in view.daily_trend.values.iter().enumerate() {
        let r = (i + 1) as u32;
        ws.write(r, 0, format!("{:02}:00", i).as_str())?;
        ws.write_with_format(r, 1, val, &c)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Sheet 4: Last 7 Days (Daily)
// ---------------------------------------------------------------------------

fn write_weekly_sheet(wb: &mut Workbook, view: &StatsView) -> Result<()> {
    write_daily_trend_sheet(wb, "Last 7 Days", &view.weekly_trend.values, 7)
}

// ---------------------------------------------------------------------------
// Sheet 5: Last 30 Days (Daily)
// ---------------------------------------------------------------------------

fn write_monthly_sheet(wb: &mut Workbook, view: &StatsView) -> Result<()> {
    write_daily_trend_sheet(wb, "Last 30 Days", &view.monthly_trend.values, 30)
}

fn write_daily_trend_sheet(
    wb: &mut Workbook,
    sheet_name: &str,
    values: &[u64],
    days: usize,
) -> Result<()> {
    let ws = wb.add_worksheet();
    ws.set_name(sheet_name)?;
    ws.set_column_width(0, 14)?;
    ws.set_column_width(1, 14)?;

    let h = header_fmt();
    let c = center_fmt();

    ws.write_with_format(0, 0, "Date", &h)?;
    ws.write_with_format(0, 1, "Down Events", &h)?;

    let today = Local::now().date_naive();
    let start = today - Duration::days((days.saturating_sub(1)) as i64);

    for (i, &val) in values.iter().enumerate() {
        let r = (i + 1) as u32;
        let date = start + Duration::days(i as i64);
        ws.write(r, 0, date.format("%Y-%m-%d").to_string().as_str())?;
        ws.write_with_format(r, 1, val, &c)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Sheet 6: Event Log
// ---------------------------------------------------------------------------

fn write_event_log_sheet(wb: &mut Workbook, events: &[RawConnectionEvent]) -> Result<()> {
    let ws = wb.add_worksheet();
    ws.set_name("Event Log")?;
    ws.set_column_width(0, 28)?;
    ws.set_column_width(1, 45)?;
    ws.set_column_width(2, 12)?;
    ws.set_column_width(3, 22)?;

    let h = header_fmt();
    let c = center_fmt();

    ws.write_with_format(0, 0, "Stream Name", &h)?;
    ws.write_with_format(0, 1, "URL", &h)?;
    ws.write_with_format(0, 2, "Event", &h)?;
    ws.write_with_format(0, 3, "Datetime", &h)?;

    for (i, ev) in events.iter().enumerate() {
        let r = (i + 1) as u32;
        ws.write(r, 0, ev.stream_name.as_str())?;
        ws.write(r, 1, ev.stream_url.as_str())?;
        ws.write_with_format(r, 2, ev.event_kind.to_uppercase().as_str(), &c)?;
        ws.write(r, 3, epoch_to_string(ev.happened_at_epoch).as_str())?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn epoch_to_string(epoch: i64) -> String {
    Local
        .timestamp_opt(epoch, 0)
        .single()
        .or_else(|| Local.timestamp_opt(epoch, 0).earliest())
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "–".to_string())
}

// Suppress dead_code warnings for Worksheet helper – called through &mut wb
#[allow(dead_code)]
fn set_col_widths(ws: &mut Worksheet, widths: &[(u16, f64)]) -> Result<()> {
    for &(col, w) in widths {
        ws.set_column_width(col, w)?;
    }
    Ok(())
}
