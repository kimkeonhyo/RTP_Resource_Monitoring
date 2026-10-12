//! RTP protocol definitions and helpers.
//!
//! These are provided so that when you replace the simulation with real
//! network I/O, you have the parsing infrastructure ready to go.

#[allow(dead_code)]
pub const RTP_VERSION: u8 = 2;
pub const RTP_HEADER_SIZE: usize = 12;

/// Parsed RTP header (RFC 3550)
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RtpHeader {
    pub version: u8,
    pub padding: bool,
    pub extension: bool,
    pub csrc_count: u8,
    pub marker: bool,
    pub payload_type: u8,
    pub sequence_number: u16,
    pub timestamp: u32,
    pub ssrc: u32,
}

#[allow(dead_code)]
impl RtpHeader {
    /// Parse an RTP header from raw bytes
    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < RTP_HEADER_SIZE {
            return None;
        }

        let version = (data[0] >> 6) & 0x03;
        if version != RTP_VERSION {
            return None;
        }

        Some(Self {
            version,
            padding: (data[0] >> 5) & 0x01 != 0,
            extension: (data[0] >> 4) & 0x01 != 0,
            csrc_count: data[0] & 0x0F,
            marker: (data[1] >> 7) & 0x01 != 0,
            payload_type: data[1] & 0x7F,
            sequence_number: u16::from_be_bytes([data[2], data[3]]),
            timestamp: u32::from_be_bytes([data[4], data[5], data[6], data[7]]),
            ssrc: u32::from_be_bytes([data[8], data[9], data[10], data[11]]),
        })
    }
}

/// Track sequence numbers per SSRC to compute packet loss
#[derive(Debug)]
#[allow(dead_code)]
pub struct SequenceTracker {
    pub ssrc: u32,
    last_seq: Option<u16>,
    received: u64,
    lost: u64,
    out_of_order: u64,
}

#[allow(dead_code)]
impl SequenceTracker {
    pub fn new(ssrc: u32) -> Self {
        Self {
            ssrc,
            last_seq: None,
            received: 0,
            lost: 0,
            out_of_order: 0,
        }
    }

    /// Process a received sequence number, returns number of packets lost
    pub fn process(&mut self, seq: u16) -> u64 {
        self.received += 1;
        let lost = match self.last_seq {
            Some(last) => {
                let expected = last.wrapping_add(1);
                if seq == expected {
                    0
                } else if seq > expected {
                    let gap = seq.wrapping_sub(expected) as u64;
                    self.lost += gap;
                    gap
                } else {
                    // Out of order or duplicate
                    self.out_of_order += 1;
                    0
                }
            }
            None => 0,
        };
        self.last_seq = Some(seq);
        lost
    }

    pub fn loss_ratio(&self) -> f64 {
        let total = self.received + self.lost;
        if total == 0 {
            0.0
        } else {
            self.lost as f64 / total as f64 * 100.0
        }
    }

    pub fn received(&self) -> u64 {
        self.received
    }

    pub fn lost(&self) -> u64 {
        self.lost
    }
}

/// Jitter calculator (RFC 3550 interarrival jitter)
#[derive(Debug)]
#[allow(dead_code)]
pub struct JitterCalculator {
    last_transit: Option<i64>,
    jitter: f64,
    clock_rate: u32,
}

#[allow(dead_code)]
impl JitterCalculator {
    pub fn new(clock_rate: u32) -> Self {
        Self {
            last_transit: None,
            jitter: 0.0,
            clock_rate,
        }
    }

    /// Update jitter estimate with arrival time (microseconds) and RTP timestamp
    pub fn update(&mut self, arrival_us: i64, rtp_timestamp: u32) -> f64 {
        let rtp_us = (rtp_timestamp as i64 * 1_000_000) / self.clock_rate as i64;
        let transit = arrival_us - rtp_us;

        if let Some(last) = self.last_transit {
            let d = (transit - last).unsigned_abs() as f64;
            // RFC 3550: J(i) = J(i-1) + (|D(i-1,i)| - J(i-1)) / 16
            self.jitter += (d - self.jitter) / 16.0;
        }
        self.last_transit = Some(transit);
        self.jitter / 1000.0 // return ms
    }

    pub fn jitter_ms(&self) -> f64 {
        self.jitter / 1000.0
    }
}
