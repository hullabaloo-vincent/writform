//! Embeddable server boot: everything `main.rs` does, callable as a library.
//! The desktop app uses this to host a server in-process ("Host on this
//! computer"); the standalone binary is a thin wrapper around it.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Context;

use crate::{db, routes, tls};

pub struct ServeOptions {
    pub data_dir: PathBuf,
    pub bind: String,
    pub port: u16,
    pub server_name: String,
    /// Serve the built web client from this directory at `/` (same-origin
    /// browser access). None = API only.
    pub web_dir: Option<PathBuf>,
    /// Registration, TLS or a proxy in front, previews (network.rs).
    pub network: crate::network::NetworkOptions,
}

/// A running server plus the identity material a local client needs to pin
/// it without a TOFU prompt (the host owns the key, so trust is implicit).
pub struct StartedServer {
    pub local_addr: SocketAddr,
    /// ML-DSA-65 public key bytes (the durable identity).
    pub identity_pubkey: Vec<u8>,
    /// DER SubjectPublicKeyInfo of the TLS cert (the TLS-level pin).
    pub spki_der: Vec<u8>,
    /// Human-checkable fingerprint, as printed for remote users to verify.
    pub fingerprint: String,
    handle: axum_server::Handle<SocketAddr>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl StartedServer {
    /// Graceful shutdown; resolves when the listener has stopped.
    pub async fn shutdown(self) {
        self.handle
            .graceful_shutdown(Some(std::time::Duration::from_secs(3)));
        let _ = self.task.await;
    }

    /// Block until the accept loop exits (standalone-binary mode).
    pub async fn wait(self) {
        let _ = self.task.await;
    }
}

/// Boot the server and resolve once it is listening (or fail with the bind /
/// bootstrap error). The accept loop runs on a spawned tokio task.
pub async fn start(opts: ServeOptions) -> anyhow::Result<StartedServer> {
    tokio::fs::create_dir_all(&opts.data_dir)
        .await
        .with_context(|| format!("creating data dir {}", opts.data_dir.display()))?;

    let tls_identity = tls::load_or_generate(&opts.data_dir).await?;
    let pool = db::connect(&opts.data_dir).await?;
    let mut state = routes::AppState::with_data_dir(
        opts.server_name.clone(),
        pool,
        &tls_identity.identity.public_key_bytes(),
        &tls_identity.cert_binding_sig,
        opts.data_dir.clone(),
    );
    state.network = std::sync::Arc::new(opts.network.clone());
    let identity_pubkey = tls_identity.identity.public_key_bytes().to_vec();
    let spki_der = tls_identity.spki_der.clone();
    let rustls_config = tls_identity.rustls_config;
    state.identity = Some(std::sync::Arc::new(tls_identity.identity));
    routes::sessions::rehydrate_timers(&state)
        .await
        .context("rehydrating prompt timers")?;
    routes::documents::start_maintenance(&state);
    let mut app = routes::router(state);
    // The browser client is same-origin static files with an SPA fallback;
    // `/api/v1/*` always wins because real routes take precedence.
    if let Some(dir) = &opts.web_dir {
        if dir.join("index.html").exists() {
            tracing::info!("serving web client from {}", dir.display());
            app = app.fallback_service(
                tower_http::services::ServeDir::new(dir)
                    .fallback(tower_http::services::ServeFile::new(dir.join("index.html"))),
            );
        } else {
            tracing::warn!(
                "web dir {} has no index.html; web client disabled",
                dir.display()
            );
        }
    }

    let addr: SocketAddr = format!("{}:{}", opts.bind, opts.port)
        .parse()
        .with_context(|| format!("invalid bind address {}:{}", opts.bind, opts.port))?;

    // Bind synchronously so a busy port surfaces as an error here, not from
    // inside the accept task.
    let listener = std::net::TcpListener::bind(addr)
        .with_context(|| format!("binding {addr} (is the port already in use?)"))?;
    listener.set_nonblocking(true).context("nonblocking")?;
    let local_addr = listener.local_addr().context("local addr")?;

    let fingerprint = writform_crypto::identity::fingerprint(&identity_pubkey);

    let handle: axum_server::Handle<SocketAddr> = axum_server::Handle::new();
    let service = app.into_make_service_with_connect_info::<SocketAddr>();
    // Behind a proxy or tunnel that speaks TLS to clients, plain HTTP here.
    let task = if opts.network.plain_http {
        let server = axum_server::from_tcp(listener)
            .context("listener")?
            .handle(handle.clone())
            .serve(service);
        tokio::spawn(server)
    } else {
        let server = axum_server::from_tcp_rustls(listener, rustls_config)
            .context("tls listener")?
            .handle(handle.clone())
            .serve(service);
        tokio::spawn(server)
    };

    let scheme = if opts.network.plain_http {
        "http"
    } else {
        "https"
    };
    tracing::info!(
        "WritForm server listening on {scheme}://{local_addr} (identity fingerprint {fingerprint})"
    );
    if opts.network.plain_http {
        tracing::info!("TLS is off: put a proxy or tunnel that speaks TLS in front of this server");
    }

    Ok(StartedServer {
        local_addr,
        identity_pubkey,
        spki_der,
        fingerprint,
        handle,
        task,
    })
}
