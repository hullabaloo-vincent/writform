//! How the server meets the network: who may make an account, whether it
//! speaks TLS itself or sits behind a proxy that does, and whose address a
//! request comes from.
//!
//! A server behind Cloudflare (or any proxy or tunnel) keeps its own address
//! to itself. The proxy shows clients its own certificate, so the apps can't
//! pin this server's; they check its identity instead with a fresh proof
//! (`POST /api/v1/identity/proof`, see docs/crypto.md).

use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderMap;
use writform_proto::api::Registration;

/// Whose address a request comes from, when a proxy stands in front.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TrustProxy {
    /// The connection's own address (no proxy, or one not trusted).
    #[default]
    None,
    /// Cloudflare's `CF-Connecting-IP`.
    Cloudflare,
    /// The last address a proxy added to `X-Forwarded-For`.
    Forwarded,
}

impl TrustProxy {
    pub fn parse(v: &str) -> Option<Self> {
        match v.trim().to_ascii_lowercase().as_str() {
            "" | "off" | "no" | "none" | "false" | "0" => Some(TrustProxy::None),
            "cloudflare" | "cf" => Some(TrustProxy::Cloudflare),
            "forwarded" | "x-forwarded-for" | "on" | "yes" | "true" | "1" => {
                Some(TrustProxy::Forwarded)
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct NetworkOptions {
    /// Who may make an account, set by the server's configuration. None: a
    /// server admin chooses in the app (anyone, until they do).
    pub registration: Option<Registration>,
    /// Plain HTTP: a proxy or tunnel in front speaks TLS to clients.
    pub plain_http: bool,
    pub trust_proxy: TrustProxy,
    /// Never fetch the links members post (each fetch shows this server's
    /// address to the site).
    pub link_previews_off: bool,
}

/// On or off, as a setting says it.
pub fn switch(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "on" | "yes" | "true" | "1" => Some(true),
        "off" | "no" | "false" | "0" => Some(false),
        _ => None,
    }
}

/// The address a request comes from.
pub fn client_ip(trust: TrustProxy, headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    match trust {
        TrustProxy::None => peer.ip(),
        TrustProxy::Cloudflare => header("cf-connecting-ip")
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(peer.ip()),
        // The proxy adds the address it saw last: what comes before it the
        // client could have written itself.
        TrustProxy::Forwarded => header("x-forwarded-for")
            .and_then(|v| v.rsplit(',').next())
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(peer.ip()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn whose_address() {
        let peer: SocketAddr = "10.0.0.9:443".parse().unwrap();
        let mut h = HeaderMap::new();
        h.insert("cf-connecting-ip", HeaderValue::from_static("203.0.113.5"));
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_static("1.2.3.4, 198.51.100.7"),
        );
        assert_eq!(client_ip(TrustProxy::None, &h, peer), peer.ip());
        assert_eq!(
            client_ip(TrustProxy::Cloudflare, &h, peer).to_string(),
            "203.0.113.5"
        );
        assert_eq!(
            client_ip(TrustProxy::Forwarded, &h, peer).to_string(),
            "198.51.100.7"
        );
        assert_eq!(
            client_ip(TrustProxy::Cloudflare, &HeaderMap::new(), peer),
            peer.ip()
        );
        assert_eq!(
            TrustProxy::parse("Cloudflare"),
            Some(TrustProxy::Cloudflare)
        );
        assert_eq!(TrustProxy::parse("maybe"), None);
    }
}
