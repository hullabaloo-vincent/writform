use clap::Parser;
use writform_server::{config, serve};

fn main() -> anyhow::Result<()> {
    // Install the aws-lc-rs provider once, before any rustls config is built —
    // it carries the hybrid X25519MLKEM768 key exchange (prefer-post-quantum).
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("install rustls crypto provider");

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "writform_server=info,tower_http=info".into()),
        )
        .init();

    let config = config::Config::parse();
    let started = serve::start(serve::ServeOptions {
        data_dir: config.data_dir,
        bind: config.bind,
        port: config.port,
        server_name: config.server_name,
        web_dir: config.web_dir,
    })
    .await?;
    started.wait().await;
    Ok(())
}
