//! plugin_data scope enforcement + round-trip.

use serde_json::json;
use writform_proto::api::AuthResponse;
use writform_proto::chat::Group;
use writform_server::routes;

async fn boot() -> (String, reqwest::Client) {
    let dir = tempfile::tempdir().unwrap();
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let state = routes::AppState::with_data_dir("P".into(), pool, b"pk", b"sig", dir.keep());
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
async fn plugin_data_scopes_enforced() {
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
    let alice = reg("alice").await;
    let bob = reg("bob").await;

    // User scope round-trip.
    let put = client
        .put(format!(
            "{base}/plugins/wf-test/data/user/{}/prefs",
            alice.user.id.0
        ))
        .bearer_auth(&alice.token)
        .json(&json!({"theme": "dark"}))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 204);
    let got: serde_json::Value = client
        .get(format!(
            "{base}/plugins/wf-test/data/user/{}/prefs",
            alice.user.id.0
        ))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["theme"], "dark");

    // Bob cannot touch Alice's user scope.
    let res = client
        .get(format!(
            "{base}/plugins/wf-test/data/user/{}/prefs",
            alice.user.id.0
        ))
        .bearer_auth(&bob.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);

    // Group scope requires membership.
    let group: Group = client
        .post(format!("{base}/groups"))
        .bearer_auth(&alice.token)
        .json(&json!({"name": "G"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let res = client
        .put(format!(
            "{base}/plugins/wf-test/data/group/{}/board",
            group.id.0
        ))
        .bearer_auth(&bob.token)
        .json(&json!({"x": 1}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let res = client
        .put(format!(
            "{base}/plugins/wf-test/data/group/{}/board",
            group.id.0
        ))
        .bearer_auth(&alice.token)
        .json(&json!({"x": 1}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    // List returns the key map.
    let all: serde_json::Value = client
        .get(format!("{base}/plugins/wf-test/data/group/{}", group.id.0))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(all["board"]["x"], 1);
}
