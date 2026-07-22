use std::path::PathBuf;

use clap::Parser;

/// Self-hosted WritForm server.
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
    #[arg(long, env = "WRITFORM_SERVER_NAME", default_value = "WritForm Server")]
    pub server_name: String,

    /// Directory with the built web client (index.html + assets). When set,
    /// the server serves the browser app at `/` alongside the API.
    #[arg(long, env = "WRITFORM_WEB_DIR")]
    pub web_dir: Option<PathBuf>,
}
