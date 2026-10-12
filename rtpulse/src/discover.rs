//! Network discovery module for capturing RTSP/RTP streams.
//!
//! Sniffs network traffic to identify:
//! - RTSP streams (via DESCRIBE/SETUP/PLAY requests on port 554)
//! - RTP multicast streams (via IGMP joins or RTP traffic)

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
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

/// Discovered stream information
#[derive(Debug, Clone)]
pub struct DiscoveredStream {
    pub url: String,
    pub name: Option<String>,
    pub protocol: StreamType,
    pub source_ip: Option<String>,
    pub dest_ip: Option<String>,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamType {
    Rtsp,
    Rtp,
}

/// Network stream discoverer
pub struct Discoverer {
    streams: HashMap<String, DiscoveredStream>,
    seen_rtsp_urls: HashSet<String>,
    seen_rtp_endpoints: HashSet<String>,
}

impl Discoverer {
    pub fn new() -> Self {
        Self {
            streams: HashMap::new(),
            seen_rtsp_urls: HashSet::new(),
            seen_rtp_endpoints: HashSet::new(),
        }
    }

    /// List available network interfaces
    pub fn list_interfaces() -> Result<Vec<String>> {
        let devices = Device::list().context("Failed to list network devices")?;
        Ok(devices.into_iter().map(|d| d.name).collect())
    }

    /// Run discovery on a network interface for a specified duration
    pub fn run(&mut self, interface: &str, duration_secs: u64, rtsp_ports: &[u16]) -> Result<()> {
        let ports_display = rtsp_ports
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        println!("Starting network discovery on interface: {}", interface);
        println!("Capturing for {} seconds...", duration_secs);
        println!(
            "Looking for RTSP (port {}) and RTP multicast traffic\n",
            ports_display
        );

        let mut cap = Capture::from_device(interface)?
            .promisc(true)
            .snaplen(65535)
            .timeout(1000) // 1 second timeout for reads
            .open()
            .context("Failed to open capture device")?;

        // Build pcap filter dynamically from given RTSP ports
        let port_filter = rtsp_ports
            .iter()
            .map(|p| format!("port {}", p))
            .collect::<Vec<_>>()
            .join(" or ");
        let filter = format!(
            "({}) or (udp and portrange 5000-65535) or igmp",
            port_filter
        );
        cap.filter(&filter, true)
            .context("Failed to set capture filter")?;

        let start = Instant::now();
        let duration = Duration::from_secs(duration_secs);

        while start.elapsed() < duration {
            match cap.next_packet() {
                Ok(packet) => {
                    self.process_packet(packet.data, rtsp_ports);
                }
                Err(pcap::Error::TimeoutExpired) => continue,
                Err(e) => {
                    eprintln!("Capture error: {}", e);
                    break;
                }
            }
        }

        println!("\nDiscovery complete!");
        Ok(())
    }

    fn process_packet(&mut self, data: &[u8], rtsp_ports: &[u16]) {
        if let Some(ethernet) = EthernetPacket::new(data) {
            match ethernet.get_ethertype() {
                EtherTypes::Ipv4 => {
                    if let Some(ipv4) = Ipv4Packet::new(ethernet.payload()) {
                        self.process_ipv4(&ipv4, rtsp_ports);
                    }
                }
                _ => {}
            }
        }
    }

    fn process_ipv4(&mut self, ipv4: &Ipv4Packet, rtsp_ports: &[u16]) {
        let src_ip = ipv4.get_source();
        let dst_ip = ipv4.get_destination();

        match ipv4.get_next_level_protocol() {
            IpNextHeaderProtocols::Tcp => {
                if let Some(tcp) = TcpPacket::new(ipv4.payload()) {
                    self.process_tcp(&tcp, src_ip, dst_ip, rtsp_ports);
                }
            }
            IpNextHeaderProtocols::Udp => {
                if let Some(udp) = UdpPacket::new(ipv4.payload()) {
                    self.process_udp(&udp, src_ip, dst_ip);
                }
            }
            IpNextHeaderProtocols::Igmp => {
                self.process_igmp(ipv4.payload(), dst_ip);
            }
            _ => {}
        }
    }

    fn process_tcp(
        &mut self,
        tcp: &TcpPacket,
        src_ip: Ipv4Addr,
        dst_ip: Ipv4Addr,
        rtsp_ports: &[u16],
    ) {
        let src_port = tcp.get_source();
        let dst_port = tcp.get_destination();

        if rtsp_ports.contains(&src_port) || rtsp_ports.contains(&dst_port) {
            let payload = tcp.payload();
            if !payload.is_empty() {
                self.parse_rtsp_packet(payload, src_ip, dst_ip, src_port, dst_port, rtsp_ports);
            }
        }
    }

    fn process_udp(&mut self, udp: &UdpPacket, _src_ip: Ipv4Addr, dst_ip: Ipv4Addr) {
        let dst_port = udp.get_destination();
        let payload = udp.payload();

        // Check if this looks like RTP (version 2, even port)
        if payload.len() >= 12 && dst_port % 2 == 0 {
            let version = (payload[0] >> 6) & 0x03;
            if version == 2 {
                // Likely RTP packet
                self.register_rtp_stream(dst_ip, dst_port);
            }
        }
    }

    fn process_igmp(&mut self, _payload: &[u8], group_addr: Ipv4Addr) {
        // IGMP join - the destination is the multicast group
        if group_addr.is_multicast() {
            // We don't know the port from IGMP alone, but we can note the group
            let key = format!("igmp:{}", group_addr);
            if !self.seen_rtp_endpoints.contains(&key) {
                self.seen_rtp_endpoints.insert(key);
                println!("  [IGMP] Multicast group join: {}", group_addr);
            }
        }
    }

    fn parse_rtsp_packet(
        &mut self,
        payload: &[u8],
        src_ip: Ipv4Addr,
        dst_ip: Ipv4Addr,
        src_port: u16,
        dst_port: u16,
        rtsp_ports: &[u16],
    ) {
        let text = match std::str::from_utf8(payload) {
            Ok(s) => s,
            Err(_) => return,
        };

        // Look for any RTSP request method that carries a URL
        for line in text.lines() {
            if line.starts_with("DESCRIBE ")
                || line.starts_with("SETUP ")
                || line.starts_with("PLAY ")
                || line.starts_with("GET_PARAMETER ")
                || line.starts_with("SET_PARAMETER ")
                || line.starts_with("ANNOUNCE ")
                || line.starts_with("PAUSE ")
                || line.starts_with("TEARDOWN ")
            {
                // Extract URL from request line: "DESCRIBE rtsp://host/path RTSP/1.0"
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let url = parts[1];
                    if url.starts_with("rtsp://") && !self.seen_rtsp_urls.contains(url) {
                        self.seen_rtsp_urls.insert(url.to_string());
                        let server_ip = if rtsp_ports.contains(&dst_port) {
                            dst_ip
                        } else {
                            src_ip
                        };
                        self.register_rtsp_stream(url, server_ip);
                    }
                }
            }
        }

        // Also look for Content-Base or Content-Location in responses
        for line in text.lines() {
            let lower = line.to_lowercase();
            if lower.starts_with("content-base:") || lower.starts_with("content-location:") {
                if let Some(url) = line.split_once(':').map(|(_, v)| v.trim()) {
                    if url.starts_with("rtsp://") && !self.seen_rtsp_urls.contains(url) {
                        self.seen_rtsp_urls.insert(url.to_string());
                        let server_ip = if rtsp_ports.contains(&src_port) {
                            src_ip
                        } else {
                            dst_ip
                        };
                        self.register_rtsp_stream(url, server_ip);
                    }
                }
            }
        }
    }

    fn register_rtsp_stream(&mut self, url: &str, server_ip: Ipv4Addr) {
        let key = url.to_string();
        if self.streams.contains_key(&key) {
            return;
        }

        println!("  [RTSP] Discovered: {}", url);

        // Build a unique name from IP + path segments (e.g. "192.0.2.10-c6-s1-live")
        let cleaned = url.trim_start_matches("rtsp://");
        let name = if let Some(host) = cleaned.split('/').next() {
            let ip = host.split(':').next().unwrap_or(host);
            // Strip credentials (user:pass@) from IP
            let ip = ip.rsplit('@').next().unwrap_or(ip);
            let segments: Vec<&str> = cleaned[host.len()..]
                .split('/')
                .filter(|s| !s.is_empty() && *s != "unicast")
                .collect();
            if segments.is_empty() {
                Some(ip.to_string())
            } else {
                Some(format!("{}-{}", ip, segments.join("-")))
            }
        } else {
            None
        };

        self.streams.insert(
            key,
            DiscoveredStream {
                url: url.to_string(),
                name,
                protocol: StreamType::Rtsp,
                source_ip: Some(server_ip.to_string()),
                dest_ip: None,
                port: 554,
            },
        );
    }

    fn register_rtp_stream(&mut self, dst_ip: Ipv4Addr, dst_port: u16) {
        // Only track multicast RTP streams
        if !dst_ip.is_multicast() {
            return;
        }

        let url = format!("rtp://{}:{}", dst_ip, dst_port);
        let key = url.clone();

        if self.streams.contains_key(&key) {
            return;
        }

        println!("  [RTP]  Discovered: {}", url);

        self.streams.insert(
            key,
            DiscoveredStream {
                url,
                name: Some(format!("Multicast {}", dst_ip)),
                protocol: StreamType::Rtp,
                source_ip: None,
                dest_ip: Some(dst_ip.to_string()),
                port: dst_port,
            },
        );
    }

    /// Get all discovered streams
    pub fn streams(&self) -> Vec<&DiscoveredStream> {
        self.streams.values().collect()
    }

    /// Write discovered streams to a YAML config file
    pub fn write_config(&self, path: &str) -> Result<()> {
        let mut file = File::create(path).context("Failed to create config file")?;

        writeln!(file, "# Auto-generated by rtpulse discover")?;
        writeln!(file, "# Discovered {} streams\n", self.streams.len())?;
        writeln!(file, "streams:")?;

        for stream in self.streams.values() {
            writeln!(file, "  - url: \"{}\"", stream.url)?;
            if let Some(ref name) = stream.name {
                writeln!(file, "    name: \"{}\"", name)?;
            }
        }

        // Note: alerts config is kept in a separate alerts.yaml file
        // so that re-running discover does not overwrite alert settings.

        println!("\nConfig written to: {}", path);
        Ok(())
    }

    /// Print summary of discovered streams
    pub fn print_summary(&self) {
        println!("\n{:=<60}", "");
        println!("Discovery Summary");
        println!("{:=<60}", "");

        let rtsp_count = self
            .streams
            .values()
            .filter(|s| s.protocol == StreamType::Rtsp)
            .count();
        let rtp_count = self
            .streams
            .values()
            .filter(|s| s.protocol == StreamType::Rtp)
            .count();

        println!("RTSP streams: {}", rtsp_count);
        println!("RTP streams:  {}", rtp_count);
        println!("Total:        {}", self.streams.len());

        if !self.streams.is_empty() {
            println!("\nDiscovered streams:");
            for stream in self.streams.values() {
                let proto = match stream.protocol {
                    StreamType::Rtsp => "RTSP",
                    StreamType::Rtp => "RTP ",
                };
                println!("  [{}] {}", proto, stream.url);
            }
        }
    }
}

impl Default for Discoverer {
    fn default() -> Self {
        Self::new()
    }
}
