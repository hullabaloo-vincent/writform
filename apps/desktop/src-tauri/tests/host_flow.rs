//! End-to-end test of "Host on this computer": the embedded server boots,
//! the local client is pre-pinned (no TOFU prompt), registration works over
//! the pinned hybrid-PQ channel, and the first account is the server admin.

use writform_desktop_lib::commands::connect::{probe_impl, register_impl, TrustStatus};
use writform_desktop_lib::host::{start_impl, HostManager};
use writform_desktop_lib::servers::ConnectionManager;

#[tokio::test]
async fn host_start_pins_and_serves() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();

    let host = HostManager::default();
    host.init(dir.path().join("config"), dir.path().join("data"));
    let conn = ConnectionManager::default();
    conn.load(dir.path().join("config"));

    // Port 0 → ephemeral; the reported status carries the real port.
    let status = start_impl(&host, &conn, 0, "Host Flow Test".into())
        .await
        .unwrap();
    assert!(status.running);
    assert!(status.configured);
    let addr = status.addr.clone().unwrap();
    assert!(status.fingerprint.is_some());

    // The host's own server is pinned at start: probing must not prompt.
    let probe = probe_impl(&conn, addr.clone()).await.unwrap();
    assert!(
        matches!(probe.trust, TrustStatus::Trusted),
        "hosted server must be pre-trusted, got {:?}",
        probe.trust
    );
    assert_eq!(probe.server_name, "Host Flow Test");

    // Register over the pinned channel; first account becomes server admin.
    let session = register_impl(&conn, addr, "host_admin".into(), "password123".into())
        .await
        .unwrap();
    assert!(session.user.is_server_admin);

    // The persisted config re-arms auto-start with the actual port.
    let config = host.config().unwrap();
    assert_eq!(config.port, status.port);
    assert!(config.auto_start);
}
