#[allow(dead_code)]
mod alert;
mod api;
mod app;
mod batch;
#[cfg(feature = "pcap-capture")]
mod capture;
#[cfg(feature = "pcap-capture")]
mod discover;
mod export;
mod monitor;
mod poller;
mod rtp;
mod rtsp;
mod stats;
mod ui;

use anyhow::Result;
use app::{App, AppTab};
use clap::{Parser, Subcommand};
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
#[cfg(feature = "pcap-capture")]
use discover::Discoverer;
use ratatui::prelude::*;
use std::io;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(name = "rtpulse", about = "Real-time RTP/RTSP stream health monitor")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Config file with stream definitions (YAML)
    #[arg(short, long, global = true)]
    config: Option<String>,

    /// Separate alerts config file (e.g. alerts.yaml). Overrides alerts in --config.
    #[arg(short = 'A', long = "alerts", global = true)]
    alerts: Option<String>,

    /// Add a stream URL to monitor
    #[arg(short = 's', long = "stream", num_args = 1.., global = true)]
    streams: Vec<String>,

    /// Refresh interval in milliseconds
    #[arg(short, long, default_value = "1000", global = true)]
    interval: u64,

    /// Run in demo mode with simulated metrics (no real network I/O)
    #[arg(long, global = true)]
    demo: bool,

    /// Enable HTTP API server on the specified port (e.g. --api-port 8080)
    #[arg(long = "api-port", global = true)]
    api_port: Option<u16>,

    /// RTPulse web API base URL for stream polling
    /// (e.g. https://watch.example.com). Can also be set via RTPULSE_API_URL.
    #[arg(long = "api-url", env = "RTPULSE_API_URL", global = true)]
    api_url: Option<String>,

    /// Customer ID for RTPulse stream polling.
    /// Can also be set via RTPULSE_CUSTOMER_ID.
    #[arg(long = "customer-id", env = "RTPULSE_CUSTOMER_ID", global = true)]
    customer_id: Option<String>,

    /// Network interface for packet capture (enables pcap-based monitoring)
    /// Requires --features pcap-capture and libpcap-dev
    #[cfg(feature = "pcap-capture")]
    #[arg(short = 'I', long = "interface", global = true)]
    interface: Option<String>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Monitor streams (default command)
    Monitor,

    /// Discover RTSP/RTP streams by capturing network traffic
    /// (requires --features pcap-capture and libpcap-dev)
    #[cfg(feature = "pcap-capture")]
    Discover {
        /// Network interface to capture on (e.g., eth0, en0)
        #[arg(short = 'I', long)]
        interface: Option<String>,

        /// Duration to capture in seconds
        #[arg(short, long, default_value = "30")]
        duration: u64,

        /// Output config file path
        #[arg(short, long, default_value = "discovered.yaml")]
        output: String,

        /// List available network interfaces and exit
        #[arg(long)]
        list_interfaces: bool,

        /// RTSP port(s) to listen on (can be specified multiple times)
        #[arg(short = 'p', long = "rtsp-port", default_values_t = vec![554u16])]
        rtsp_ports: Vec<u16>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        #[cfg(feature = "pcap-capture")]
        Some(Command::Discover {
            interface,
            duration,
            output,
            list_interfaces,
            rtsp_ports,
        }) => {
            run_discover(interface, duration, output, list_interfaces, rtsp_ports)?;
        }
        Some(Command::Monitor) | None => {
            run_monitor(cli).await?;
        }
    }

    Ok(())
}

#[cfg(feature = "pcap-capture")]
fn run_discover(
    interface: Option<String>,
    duration: u64,
    output: String,
    list_interfaces: bool,
    rtsp_ports: Vec<u16>,
) -> Result<()> {
    if list_interfaces {
        println!("Available network interfaces:");
        for iface in Discoverer::list_interfaces()? {
            println!("  {}", iface);
        }
        return Ok(());
    }

    let iface = match interface {
        Some(i) => i,
        None => {
            // Try to find a reasonable default
            let interfaces = Discoverer::list_interfaces()?;
            if interfaces.is_empty() {
                anyhow::bail!("No network interfaces found. Try running with sudo/root.");
            }
            // Prefer common interface names
            let preferred = ["eth0", "en0", "ens33", "enp0s3", "wlan0", "wlp2s0"];
            let default = interfaces
                .iter()
                .find(|i| preferred.contains(&i.as_str()))
                .or(interfaces.first())
                .cloned()
                .unwrap();
            println!("Using default interface: {}", default);
            println!("(Use -I/--interface to specify a different one)\n");
            default
        }
    };

    let mut discoverer = Discoverer::new();
    discoverer.run(&iface, duration, &rtsp_ports)?;
    discoverer.print_summary();

    if !discoverer.streams().is_empty() {
        discoverer.write_config(&output)?;
        println!("\nTo monitor discovered streams:");
        println!("  rtpulse -c {}", output);
    } else {
        println!("\nNo streams discovered. Try:");
        println!("  - Running with sudo/root for promiscuous mode");
        println!("  - Capturing for longer duration (-d 60)");
        println!("  - Ensuring RTSP/RTP traffic is active on the network");
    }

    Ok(())
}

async fn run_monitor(cli: Cli) -> Result<()> {
    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // Extract interface for capture mode
    #[cfg(feature = "pcap-capture")]
    let interface = cli.interface;
    #[cfg(not(feature = "pcap-capture"))]
    let interface: Option<String> = None;

    // Create app
    let mut app = App::new(cli.interval, cli.demo, interface);

    // Load config or CLI streams
    if let Some(config_path) = &cli.config {
        app.load_config(config_path)?;
    }
    if let Some(alerts_path) = &cli.alerts {
        app.load_alerts_config(alerts_path)?;
    }
    for url in &cli.streams {
        app.add_stream(url);
    }

    // If no streams provided and running in demo mode, add demo streams
    if app.streams.is_empty() && cli.demo {
        app.add_stream("rtsp://demo.example.com:554/live/stream1");
        app.add_stream("rtsp://demo.example.com:554/live/stream2");
        app.add_stream("rtp://239.1.1.1:5004");
        app.add_stream("rtsp://camera-01.local:554/h264");
        app.add_stream("rtp://239.1.1.2:5006");
    }

    // Start monitoring tasks
    app.start_monitoring().await;

    // Start RTPulse stream poller (if --api-url + --customer-id are configured)
    let poll_add_queue: poller::PollAddQueue =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let poll_remove_queue: poller::PollRemoveQueue =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let poll_rename_queue: poller::PollRenameQueue =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

    if let (Some(api_url), Some(customer_id)) = (cli.api_url, cli.customer_id) {
        if !cli.demo {
            poller::spawn_poller(
                api_url,
                customer_id,
                poll_add_queue.clone(),
                poll_remove_queue.clone(),
                poll_rename_queue.clone(),
            );
        } else {
            eprintln!("[rtpulse] Poller disabled in demo mode");
        }
    }

    // Start optional HTTP API server
    let shared_api_state: Option<crate::api::SharedApiState>;
    let command_queue: Option<crate::api::CommandQueue>;
    let remove_command_queue: Option<crate::api::RemoveCommandQueue>;

    if let Some(port) = cli.api_port {
        let shared =
            std::sync::Arc::new(std::sync::RwLock::new(crate::api::ApiSnapshot::default()));
        let cmds: crate::api::CommandQueue = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let removes: crate::api::RemoveCommandQueue =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let shared_clone = shared.clone();
        let cmds_clone = cmds.clone();
        let removes_clone = removes.clone();
        // Share the same dynamic_slack from App so API writes are seen by the dispatcher
        let slack_clone = app.dynamic_slack.clone();
        tokio::spawn(async move {
            crate::api::serve(port, shared_clone, cmds_clone, removes_clone, slack_clone).await;
        });
        shared_api_state = Some(shared);
        command_queue = Some(cmds);
        remove_command_queue = Some(removes);
    } else {
        shared_api_state = None;
        command_queue = None;
        remove_command_queue = None;
    }

    // Main loop
    let res = run_app(
        &mut terminal,
        &mut app,
        shared_api_state,
        command_queue,
        remove_command_queue,
        poll_add_queue,
        poll_remove_queue,
        poll_rename_queue,
    )
    .await;

    // Restore terminal
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    if let Err(err) = res {
        eprintln!("Error: {err:?}");
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_app<B: Backend>(
    terminal: &mut Terminal<B>,
    app: &mut App,
    shared_api_state: Option<crate::api::SharedApiState>,
    command_queue: Option<crate::api::CommandQueue>,
    remove_command_queue: Option<crate::api::RemoveCommandQueue>,
    poll_add_queue: poller::PollAddQueue,
    poll_remove_queue: poller::PollRemoveQueue,
    poll_rename_queue: poller::PollRenameQueue,
) -> Result<()> {
    loop {
        terminal.draw(|f| ui::draw(f, app))?;

        // Poll with timeout for responsive UI
        if event::poll(Duration::from_millis(100))?
            && let Event::Key(key) = event::read()?
        {
            match (key.code, key.modifiers) {
                (KeyCode::Char('q'), _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                    return Ok(());
                }
                (KeyCode::Up | KeyCode::Char('k'), _) => app.previous_stream(),
                (KeyCode::Down | KeyCode::Char('j'), _) => app.next_stream(),
                (KeyCode::Tab, _) => app.next_tab(),
                (KeyCode::BackTab, _) => app.prev_tab(),
                (KeyCode::Char('a'), _) => app.toggle_add_dialog(),
                (KeyCode::Char('d'), _) => app.delete_selected_stream(),
                #[cfg(feature = "pcap-capture")]
                (KeyCode::Char('D'), _) => app.start_live_discover(15),
                (KeyCode::Char('r'), _) => app.restart_selected_stream().await,
                (KeyCode::Char('p'), _) => app.toggle_pause(),
                (KeyCode::Char('e'), _) => app.export_stats(),
                (KeyCode::Char('f'), _) if app.tab == AppTab::Stats => app.cycle_stats_filter(),
                (KeyCode::Char('/'), _) => app.toggle_sort(),
                (KeyCode::Enter, _) => {
                    if app.show_add_dialog {
                        app.confirm_add_stream().await;
                    }
                }
                (KeyCode::Esc, _) => {
                    if app.show_add_dialog {
                        app.toggle_add_dialog();
                    }
                }
                (KeyCode::Char(c), _) if app.show_add_dialog => {
                    app.input_buffer.push(c);
                }
                (KeyCode::Backspace, _) if app.show_add_dialog => {
                    app.input_buffer.pop();
                }
                _ => {}
            }
        }

        // Drain stream-add commands from the HTTP API
        if let Some(ref cmds) = command_queue {
            let pending: Vec<_> = cmds.lock().unwrap().drain(..).collect();
            for cmd in pending {
                app.add_and_start_monitor(&cmd.url, &cmd.name).await;
            }
        }

        // Drain stream-remove commands from the HTTP API
        if let Some(ref rcmds) = remove_command_queue {
            let pending: Vec<_> = rcmds.lock().unwrap().drain(..).collect();
            for id in pending {
                app.remove_stream_by_id(id);
            }
        }

        // Drain stream-add commands from the RTPulse poller
        {
            let pending: Vec<_> = poll_add_queue.lock().unwrap().drain(..).collect();
            for cmd in pending {
                app.add_polled_stream(&cmd.url, &cmd.name).await;
            }
        }

        // Drain stream-remove commands from the RTPulse poller
        {
            let pending: Vec<_> = poll_remove_queue.lock().unwrap().drain(..).collect();
            for url in pending {
                app.remove_polled_stream_by_url(&url);
            }
        }

        // Drain stream-rename commands from the RTPulse poller (name changed, URL same)
        {
            let pending: Vec<_> = poll_rename_queue.lock().unwrap().drain(..).collect();
            for cmd in pending {
                app.rename_polled_stream_by_url(&cmd.url, &cmd.new_name);
            }
        }

        // Update metrics from monitoring tasks
        app.update_metrics().await;
        if let Some(ref shared) = shared_api_state {
            app.update_api_state(shared);
        }
        #[cfg(feature = "pcap-capture")]
        app.poll_discover_results();
    }
}
