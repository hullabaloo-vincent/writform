//! Profile avatar/accent + group icon/color customization endpoints.

use serde_json::json;
use writform_proto::api::{AuthResponse, User};
use writform_proto::chat::Group;
use writform_server::routes;

async fn boot() -> (String, reqwest::Client) {
    let dir = tempfile::tempdir().unwrap();
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let state =
        routes::AppState::with_data_dir("Custom Test".into(), pool, b"pk", b"sig", dir.keep());
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

async fn register(base: &str, client: &reqwest::Client, name: &str) -> AuthResponse {
    client
        .post(format!("{base}/auth/register"))
        .json(&json!({"username": name, "password": "password-123"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn profile_and_group_customization() {
    let (base, client) = boot().await;
    let alice = register(&base, &client, "alice").await;
    let bob = register(&base, &client, "bob").await;

    // Bad color rejected.
    let res = client
        .patch(format!("{base}/auth/me"))
        .bearer_auth(&alice.token)
        .json(&json!({"display_name": "Alice", "accent_color": "red"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);

    // Upload an avatar and set profile appearance.
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0])
            .file_name("avatar.png"),
    );
    let att: serde_json::Value = client
        .post(format!("{base}/attachments"))
        .bearer_auth(&alice.token)
        .multipart(form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let att_id = att["id"].as_i64().unwrap();

    let me: User = client
        .patch(format!("{base}/auth/me"))
        .bearer_auth(&alice.token)
        .json(&json!({
            "display_name": "Alice",
            "avatar_attachment_id": att_id,
            "accent_color": "#8ab6e8"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me.accent_color.as_deref(), Some("#8ab6e8"));
    assert_eq!(me.avatar_attachment_id.map(|a| a.0), Some(att_id));

    // Bob can't use Alice's upload as his avatar.
    let res = client
        .patch(format!("{base}/auth/me"))
        .bearer_auth(&bob.token)
        .json(&json!({"display_name": null, "avatar_attachment_id": att_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);

    // Group customization: members 403, admin ok, visible in listing.
    let group: Group = client
        .post(format!("{base}/groups"))
        .bearer_auth(&alice.token)
        .json(&json!({"name": "Writers"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let invite: serde_json::Value = client
        .post(format!("{base}/groups/{}/invites", group.id.0))
        .bearer_auth(&alice.token)
        .json(&json!({"expires_in_seconds": null, "max_uses": null}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    client
        .post(format!("{base}/invites/redeem"))
        .bearer_auth(&bob.token)
        .json(&json!({"code": invite["code"]}))
        .send()
        .await
        .unwrap();

    let res = client
        .patch(format!("{base}/groups/{}", group.id.0))
        .bearer_auth(&bob.token)
        .json(&json!({"name": "Hijacked", "icon_attachment_id": null, "accent_color": null}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);

    let updated: Group = client
        .patch(format!("{base}/groups/{}", group.id.0))
        .bearer_auth(&alice.token)
        .json(&json!({
            "name": "Writers Guild",
            "icon_attachment_id": att_id,
            "accent_color": "#93d3a2"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(updated.name, "Writers Guild");
    assert_eq!(updated.accent_color.as_deref(), Some("#93d3a2"));

    let groups: Vec<Group> = client
        .get(format!("{base}/groups"))
        .bearer_auth(&bob.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(groups[0].accent_color.as_deref(), Some("#93d3a2"));
    assert_eq!(groups[0].icon_attachment_id.map(|a| a.0), Some(att_id));
}
