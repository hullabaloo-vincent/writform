use std::path::PathBuf;

use clap::Parser;

/// Self-hosted subScribe server.
#[derive(Debug, Parser)]
#[command(name = "writform-server", version)]
pub struct Config {
    /// Directory for the database, attachments, and identity keys.
    #[arg(long, env = "WRITFORM_DATA_DIR", default_value = "./data")]
    pub data_dir: PathBuf,

    /// Address to bind.
    #[arg(long, env = "WRITFORM_BIND", default_value = "0.0.0.0")]
    pub bind: String,

    /// Port to listen on.
    #[arg(long, env = "WRITFORM_PORT", default_value_t = 7311)]
    pub port: u16,

    /// Human-readable server name shown to clients during TOFU.
    #[arg(long, env = "WRITFORM_SERVER_NAME", default_value = "subScribe Server")]
    pub server_name: String,

    /// Directory with the built web client (index.html + assets). When set,
    /// the server serves the browser app at `/` alongside the API.
    #[arg(long, env = "WRITFORM_WEB_DIR")]
    pub web_dir: Option<PathBuf>,

    /// Who may make an account: `open`, `invite` (with a code from a server
    /// admin) or `closed`. Unset: a server admin chooses in the app.
    #[arg(long, env = "WRITFORM_REGISTRATION")]
    pub registration: Option<String>,

    /// `off`: serve plain HTTP, for a proxy or tunnel in front that speaks
    /// TLS to clients (Cloudflare Tunnel, Caddy, nginx).
    #[arg(long, env = "WRITFORM_TLS", default_value = "on")]
    pub tls: String,

    /// Behind a proxy, read each client's address from its header:
    /// `cloudflare` (CF-Connecting-IP) or `forwarded` (X-Forwarded-For).
    /// Only behind such a proxy: otherwise anyone could say any address.
    #[arg(long, env = "WRITFORM_TRUST_PROXY")]
    pub trust_proxy: Option<String>,

    /// `off`: never fetch the links members post to show a preview (each
    /// fetch shows this server's address to the site).
    #[arg(long, env = "WRITFORM_LINK_PREVIEWS", default_value = "on")]
    pub link_previews: String,
}

impl Config {
    /// The network settings, or what is wrong with them.
    pub fn network(&self) -> anyhow::Result<crate::network::NetworkOptions> {
        use crate::network::{switch, NetworkOptions, TrustProxy};
        use writform_proto::api::Registration;
        let registration = match &self.registration {
            Some(v) if !v.trim().is_empty() => Some(Registration::parse(v).ok_or_else(|| {
                anyhow::anyhow!("WRITFORM_REGISTRATION must be open, invite or closed (not {v:?})")
            })?),
            _ => None,
        };
        let tls = switch(&self.tls).ok_or_else(|| {
            anyhow::anyhow!("WRITFORM_TLS must be on or off (not {:?})", self.tls)
        })?;
        let trust_proxy = match &self.trust_proxy {
            Some(v) => TrustProxy::parse(v).ok_or_else(|| {
                anyhow::anyhow!(
                    "WRITFORM_TRUST_PROXY must be cloudflare, forwarded or off (not {v:?})"
                )
            })?,
            None => TrustProxy::None,
        };
        let previews = switch(&self.link_previews).ok_or_else(|| {
            anyhow::anyhow!(
                "WRITFORM_LINK_PREVIEWS must be on or off (not {:?})",
                self.link_previews
            )
        })?;
        Ok(NetworkOptions {
            registration,
            plain_http: !tls,
            trust_proxy,
            link_previews_off: !previews,
        })
    }
}
