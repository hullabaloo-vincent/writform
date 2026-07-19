//! First-user-is-admin, admin guard, stats, device list/revoke, profile.

use serde_json::json;
use writform_proto::api::{AdminStats, AuthResponse, DeviceSession, User};
use writform_server::routes;

async fn boot() -> (String, reqwest::Client) {
    let dir = tempfile::tempdir().unwrap();
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let state = routes::AppState::with_data_dir("A".into(), pool, b"pk", b"sig", dir.keep());
    let app = routes::router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (
        format!("http://127.0.0.1:{}/api/v1", addr.port()),
        reqwest::Client::new(),
    )
}

#[tokio::test]
async fn admin_and_devices() {
    let (base, client) = boot().await;
    let reg = |u: &str| {
        let base = base.clone();
        let client = client.clone();
        let u = u.to_string();
        async move {
            client
                .post(format!("{base}/auth/register"))
                .json(&json!({"username": u, "password": "password-123"}))
                .send()
                .await
                .unwrap()
                .json::<AuthResponse>()
                .await
                .unwrap()
        }
    };

    // First registered user is the server admin; later ones are not.
    let alice = reg("alice").await;
    let bob = reg("bob").await;
    assert!(alice.user.is_server_admin);
    assert!(!bob.user.is_server_admin);

    // Admin endpoints: bob forbidden, alice sees stats.
    let res = client
        .get(format!("{base}/admin/stats"))
        .bearer_auth(&bob.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let stats: AdminStats = client
        .get(format!("{base}/admin/stats"))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stats.users, 2);

    // Profile update round-trips.
    let me: User = client
        .patch(format!("{base}/auth/me"))
        .bearer_auth(&bob.token)
        .json(&json!({"display_name": "Bobby"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me.display_name.as_deref(), Some("Bobby"));

    // Devices: bob logs in twice, sees both, revokes the other one.
    let second = client
        .post(format!("{base}/auth/login"))
        .json(&json!({"username": "bob", "password": "password-123", "device_label": "laptop"}))
        .send()
        .await
        .unwrap()
        .json::<AuthResponse>()
        .await
        .unwrap();
    let devices: Vec<DeviceSession> = client
        .get(format!("{base}/auth/devices"))
        .bearer_auth(&bob.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(devices.len(), 2);
    let other = devices.iter().find(|d| !d.current).unwrap();
    let res = client
        .delete(format!("{base}/auth/devices/{}", other.id))
        .bearer_auth(&bob.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    // The revoked token no longer works.
    let res = client
        .get(format!("{base}/auth/me"))
        .bearer_auth(&second.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);

    // Admin force-logout kills all of a user's sessions.
    let res = client
        .post(format!("{base}/admin/users/{}/logout", bob.user.id.0))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let res = client
        .get(format!("{base}/auth/me"))
        .bearer_auth(&bob.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}
