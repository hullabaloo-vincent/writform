//! True end-to-end test of the client connect stack against a real server:
//! TOFU probe with binding verification → trust → pinned register/login →
//! pin-mismatch rejection. Exercises hybrid-PQ TLS on both sides.

use std::net::SocketAddr;

use writform_desktop_lib::commands::connect::{
    disconnect_impl, list_impl, login_impl, probe_impl, register_impl, resume_impl, target_impl,
    trust_impl, TrustStatus,
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
        false,
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
        false,
        None,
    )
    .await
    .unwrap();
    assert_eq!(session.user.username, "alice");

    let session = login_impl(
        &manager,
        addr_str.clone(),
        "alice".into(),
        "pass-word-1".into(),
        true,
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
    // "Remember me" on the last login persisted the session token.
    assert!(reloaded.find(&addr_str).unwrap().session_token.is_some());
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
        session_token: None,
        last_active_at: None,
        paused: false,
    });

    // The pinned TLS handshake itself must refuse the connection.
    let err = login_impl(
        &manager,
        addr_str.clone(),
        "alice".into(),
        "pass-word-1".into(),
        false,
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

/// A trusted server with a remembered session for `alice`.
async fn remembered(
    server_dir: &std::path::Path,
    client_dir: &std::path::Path,
) -> (ConnectionManager, String) {
    let addr = boot_server(server_dir, "Resume Server").await;
    let addr_str = format!("127.0.0.1:{}", addr.port());
    let manager = manager_in(client_dir);
    probe_impl(&manager, addr_str.clone()).await.unwrap();
    trust_impl(&manager, addr_str.clone()).unwrap();
    register_impl(
        &manager,
        addr_str.clone(),
        "alice".into(),
        "pass-word-1".into(),
        true,
        None,
    )
    .await
    .unwrap();
    (manager, addr_str)
}

const NO_PATIENCE: std::time::Duration = std::time::Duration::ZERO;

#[tokio::test]
async fn disconnect_keeps_the_token_and_resume_brings_the_session_back() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let server_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();
    let (manager, addr) = remembered(server_dir.path(), client_dir.path()).await;

    // Connected: nothing for launch to resume, and the list says signed in.
    assert!(target_impl(&manager).is_none());
    let listed = list_impl(&manager);
    assert!(listed[0].signed_in);
    assert!(
        listed[0].server.session_token.is_none(),
        "the token never leaves the core"
    );

    // Disconnect: no active session, token kept, launch stays put.
    disconnect_impl(&manager);
    assert!(manager.active.lock().unwrap().is_none());
    let saved = manager.find(&addr).unwrap();
    assert!(saved.session_token.is_some());
    assert!(saved.paused);
    assert!(
        target_impl(&manager).is_none(),
        "a server left on purpose isn't resumed at launch"
    );
    // …and that survives a restart.
    let relaunched = manager_in(client_dir.path());
    assert!(target_impl(&relaunched).is_none());
    assert!(list_impl(&relaunched)[0].signed_in);

    // Coming back needs no password.
    let result = resume_impl(&relaunched, relaunched.find(&addr).unwrap(), NO_PATIENCE).await;
    let session = result.session.expect("the remembered token still stands");
    assert_eq!(session.user.username, "alice");
    assert!(!relaunched.find(&addr).unwrap().paused);
    assert!(relaunched.active.lock().unwrap().is_some());

    // A fresh launch after that resumes by itself again.
    let again = manager_in(client_dir.path());
    assert_eq!(target_impl(&again).unwrap().addr, addr);
    assert_eq!(
        target_impl(&again).unwrap().last_username.as_deref(),
        Some("alice")
    );
}

#[tokio::test]
async fn a_rejected_token_is_forgotten_and_an_absent_server_keeps_it() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let server_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();
    let (manager, addr) = remembered(server_dir.path(), client_dir.path()).await;

    // Expired: the server no longer knows the token.
    let relaunched = manager_in(client_dir.path());
    let mut stale = relaunched.find(&addr).unwrap();
    stale.session_token = Some("not-a-real-token".into());
    relaunched.upsert(stale.clone());
    let result = resume_impl(&relaunched, stale, NO_PATIENCE).await;
    assert!(result.session.is_none());
    assert_eq!(result.reason.as_deref(), Some("expired"));
    assert_eq!(result.addr.as_deref(), Some(addr.as_str()));
    assert!(
        relaunched.find(&addr).unwrap().session_token.is_none(),
        "a dead token is dropped"
    );

    // Unreachable: a pinned server that isn't there. The token stays for
    // when it is.
    let mut gone = manager.find(&addr).unwrap();
    gone.addr = "127.0.0.1:9".into();
    manager.upsert(gone.clone());
    let started = std::time::Instant::now();
    let result = resume_impl(&manager, gone.clone(), NO_PATIENCE).await;
    assert!(result.session.is_none());
    assert_eq!(result.reason.as_deref(), Some("unreachable"));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(9),
        "resume is bounded"
    );
    assert!(manager.find("127.0.0.1:9").unwrap().session_token.is_some());

    // With patience (the server this app hosts, still starting) it keeps
    // trying for that long before giving up.
    let started = std::time::Instant::now();
    let patience = std::time::Duration::from_millis(900);
    let result = resume_impl(&manager, gone, patience).await;
    assert_eq!(result.reason.as_deref(), Some("unreachable"));
    assert!(started.elapsed() >= patience);
}

/// A server whose certificate its identity doesn't vouch for, and which no
/// public authority vouches for either (an interceptor's): refused, as it
/// always was, though a server behind a proxy is now accepted.
#[tokio::test]
async fn a_certificate_nobody_vouches_for_is_still_refused() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let server_dir = tempfile::tempdir().unwrap();
    let client_dir = tempfile::tempdir().unwrap();
    let tls_identity = tls::load_or_generate(server_dir.path()).await.unwrap();
    let pool = db::connect(server_dir.path()).await.unwrap();
    // The identity signs some other certificate's key, not the one served.
    let wrong = tls_identity
        .identity
        .sign_cert_binding(b"another certificate's key");
    let mut state = routes::AppState::new(
        "Intercepted".into(),
        pool,
        &tls_identity.identity.public_key_bytes(),
        &wrong,
    );
    state.identity = Some(std::sync::Arc::new(tls_identity.identity));
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
    let manager = manager_in(client_dir.path());
    let err = probe_impl(&manager, format!("127.0.0.1:{}", addr.port()))
        .await
        .unwrap_err();
    assert_eq!(err.code, "binding_invalid", "{}", err.message);
    assert!(manager
        .find(&format!("127.0.0.1:{}", addr.port()))
        .is_none());
}
