//! RTSP protocol definitions and helpers.
//!
//! Provided for extending the monitor with real RTSP DESCRIBE/SETUP/PLAY
//! and RTCP receiver report parsing.

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub enum RtspMethod {
    Options,
    Describe,
    Setup,
    Play,
    Pause,
    Teardown,
    GetParameter,
}

#[allow(dead_code)]
impl RtspMethod {
    pub fn as_str(&self) -> &str {
        match self {
            RtspMethod::Options => "OPTIONS",
            RtspMethod::Describe => "DESCRIBE",
            RtspMethod::Setup => "SETUP",
            RtspMethod::Play => "PLAY",
            RtspMethod::Pause => "PAUSE",
            RtspMethod::Teardown => "TEARDOWN",
            RtspMethod::GetParameter => "GET_PARAMETER",
        }
    }
}

/// Parsed RTSP URL components
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RtspUrl {
    pub host: String,
    pub port: u16,
    pub path: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[allow(dead_code)]
impl RtspUrl {
    pub fn parse(url: &str) -> Option<Self> {
        let stripped = url.strip_prefix("rtsp://")?;

        // Check for credentials
        let (auth, rest) = if let Some(at_pos) = stripped.find('@') {
            let auth_part = &stripped[..at_pos];
            let rest_part = &stripped[at_pos + 1..];
            let (user, pass) = if let Some(colon) = auth_part.find(':') {
                (
                    Some(auth_part[..colon].to_string()),
                    Some(auth_part[colon + 1..].to_string()),
                )
            } else {
                (Some(auth_part.to_string()), None)
            };
            ((user, pass), rest_part)
        } else {
            ((None, None), stripped)
        };

        // Split host:port from path
        let (hostport, path) = if let Some(slash) = rest.find('/') {
            (&rest[..slash], rest[slash..].to_string())
        } else {
            (rest, "/".to_string())
        };

        let (host, port) = if let Some(colon) = hostport.rfind(':') {
            let port_str = &hostport[colon + 1..];
            if let Ok(p) = port_str.parse::<u16>() {
                (hostport[..colon].to_string(), p)
            } else {
                (hostport.to_string(), 554)
            }
        } else {
            (hostport.to_string(), 554)
        };

        Some(Self {
            host,
            port,
            path,
            username: auth.0,
            password: auth.1,
        })
    }

    pub fn to_url(&self) -> String {
        format!("rtsp://{}:{}{}", self.host, self.port, self.path)
    }
}

/// Build a simple RTSP request string
#[allow(dead_code)]
pub fn build_request(method: RtspMethod, url: &str, cseq: u32, session: Option<&str>) -> String {
    let mut req = format!("{} {} RTSP/1.0\r\n", method.as_str(), url);
    req.push_str(&format!("CSeq: {cseq}\r\n"));
    if let Some(sess) = session {
        req.push_str(&format!("Session: {sess}\r\n"));
    }
    req.push_str("User-Agent: rtpulse/0.1\r\n");
    req.push_str("\r\n");
    req
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_rtsp_url() {
        let url = RtspUrl::parse("rtsp://admin:pass@192.0.2.10:554/live/main").unwrap(); // example
        assert_eq!(url.host, "192.0.2.10");
        assert_eq!(url.port, 554);
        assert_eq!(url.path, "/live/main");
        assert_eq!(url.username.as_deref(), Some("admin"));
        assert_eq!(url.password.as_deref(), Some("pass"));
    }

    #[test]
    fn test_parse_simple_url() {
        let url = RtspUrl::parse("rtsp://camera.local/stream1").unwrap();
        assert_eq!(url.host, "camera.local");
        assert_eq!(url.port, 554);
        assert_eq!(url.path, "/stream1");
    }
}
