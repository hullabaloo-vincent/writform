//! True end-to-end test of the client connect stack against a real server:
//! TOFU probe with binding verification → trust → pinned register/login →
//! pin-mismatch rejection. Exercises hybrid-PQ TLS on both sides.

use std::net::SocketAddr;

use writform_desktop_lib::commands::connect::{
    login_impl, probe_impl, register_impl, trust_impl, TrustStatus,
};
use writform_desktop_lib::servers::{ConnectionManager, SavedServer};
use writform_server::{db, routes, tls};

async fn boot_server(data_dir: &std::path::Path, name: &str) -> SocketAddr {
    let tls_identity = tls::load_or_generate(data_dir).await.unwrap();
    let pool = db::connect(data_dir).await.unwrap();
    let state = routes::AppState::new(
        name.into(),
        pool,
        &tls_identity.identity.public_key_bytes(),
        &tls_identity.cert_binding_sig,
    );
    let app = routes::router(state);

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum_server::from_tcp_rustls(listener, tls_identity.rustls_config)
            .unwrap()
            .serve(app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    addr
}

fn manager_in(dir: &std::path::Path) -> ConnectionManager {
    let manager = ConnectionManager::default();
    manager.load(dir.to_path_buf());
    manager
}

#[tokio::test]
async fn tofu_trust_register_login_end_to_end() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let server_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();
    let addr = boot_server(server_dir.path(), "E2E Server").await;
    let addr_str = format!("127.0.0.1:{}", addr.port());

    let manager = manager_in(client_dir.path());

    // First probe: unknown server → New with a fingerprint to approve.
    let probe = probe_impl(&manager, addr_str.clone()).await.unwrap();
    assert_eq!(probe.server_name, "E2E Server");
    assert!(matches!(probe.trust, TrustStatus::New { .. }));

    // Login before trusting must fail.
    let err = login_impl(
        &manager,
        addr_str.clone(),
        "alice".into(),
        "pass-word-1".into(),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "not_trusted");

    // Approve trust, then register + login over the PINNED client.
    trust_impl(&manager, addr_str.clone()).unwrap();
    let session = register_impl(
        &manager,
        addr_str.clone(),
        "alice".into(),
        "pass-word-1".into(),
    )
    .await
    .unwrap();
    assert_eq!(session.user.username, "alice");

    let session = login_impl(
        &manager,
        addr_str.clone(),
        "alice".into(),
        "pass-word-1".into(),
    )
    .await
    .unwrap();
    assert_eq!(session.user.username, "alice");

    // Re-probe: now recognized as trusted, no prompt.
    let probe = probe_impl(&manager, addr_str.clone()).await.unwrap();
    assert!(matches!(probe.trust, TrustStatus::Trusted));

    // Pins persisted to disk.
    let reloaded = manager_in(client_dir.path());
    assert_eq!(
        reloaded.find(&addr_str).unwrap().last_username,
        Some("alice".into())
    );
}

#[tokio::test]
async fn wrong_pin_is_rejected_and_identity_change_is_flagged() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let server_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();
    let addr = boot_server(server_dir.path(), "Pin Server").await;
    let addr_str = format!("127.0.0.1:{}", addr.port());

    let manager = manager_in(client_dir.path());

    // Plant a bogus pin for this server (simulates a MITM/identity swap).
    manager.upsert(SavedServer {
        addr: addr_str.clone(),
        server_name: "Pin Server".into(),
        identity_hash: "00".repeat(32),
        spki_hash: "00".repeat(32),
        fingerprint: "dead-beef-dead-beef".into(),
        last_username: None,
    });

    // The pinned TLS handshake itself must refuse the connection.
    let err = login_impl(
        &manager,
        addr_str.clone(),
        "alice".into(),
        "pass-word-1".into(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        err.code, "pin_mismatch",
        "got: {} — {}",
        err.code, err.message
    );

    // A probe sees a server whose identity differs from the stored pin.
    let probe = probe_impl(&manager, addr_str.clone()).await.unwrap();
    assert!(matches!(probe.trust, TrustStatus::IdentityChanged { .. }));
}
