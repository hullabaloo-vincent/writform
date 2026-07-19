use std::net::SocketAddr;

use anyhow::Context;
use clap::Parser;
use writform_server::{config, db, routes, tls};

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
    tokio::fs::create_dir_all(&config.data_dir)
        .await
        .with_context(|| format!("creating data dir {}", config.data_dir.display()))?;

    let tls_identity = tls::load_or_generate(&config.data_dir).await?;
    let pool = db::connect(&config.data_dir).await?;
    let state = routes::AppState::with_data_dir(
        config.server_name.clone(),
        pool,
        &tls_identity.identity.public_key_bytes(),
        &tls_identity.cert_binding_sig,
        config.data_dir.clone(),
    );
    routes::sessions::rehydrate_timers(&state)
        .await
        .context("rehydrating prompt timers")?;
    let app = routes::router(state);

    let addr: SocketAddr = format!("{}:{}", config.bind, config.port)
        .parse()
        .with_context(|| format!("invalid bind address {}:{}", config.bind, config.port))?;
    tracing::info!(
        "WritForm server listening on https://{addr} (identity fingerprint {})",
        writform_crypto::identity::fingerprint(&tls_identity.identity.public_key_bytes())
    );

    axum_server::bind_rustls(addr, tls_identity.rustls_config)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
        .await?;
    Ok(())
}
