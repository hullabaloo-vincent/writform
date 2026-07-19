//! Friends & DMs: request → accept (including reverse-request auto-accept),
//! DM open/get-or-create, DM permission boundary, message flow, removal.

use serde_json::json;
use writform_proto::api::AuthResponse;
use writform_proto::chat::Message;
use writform_proto::friends::{DmChannel, Friend, FriendRequest, FriendRequests};
use writform_server::routes;

struct TestServer {
    base: String,
    client: reqwest::Client,
}

async fn boot() -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let state = routes::AppState::with_data_dir("F".into(), pool, b"pk", b"sig", dir.keep());
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
    TestServer {
        base: format!("http://127.0.0.1:{}/api/v1", addr.port()),
        client: reqwest::Client::new(),
    }
}

impl TestServer {
    async fn register(&self, username: &str) -> AuthResponse {
        self.client
            .post(format!("{}/auth/register", self.base))
            .json(&json!({"username": username, "password": "password-123"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    async fn req(
        &self,
        method: reqwest::Method,
        token: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> reqwest::Response {
        let mut r = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token);
        if let Some(body) = body {
            r = r.json(&body);
        }
        r.send().await.unwrap()
    }
}

#[tokio::test]
async fn friends_and_dms_end_to_end() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let carol = server.register("carol").await;

    // Alice → Bob request.
    let res = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            "/friends/requests",
            Some(json!({"username": "bob"})),
        )
        .await;
    assert_eq!(res.status(), 200);

    // Bob sees it incoming and accepts.
    let requests: FriendRequests = server
        .req(reqwest::Method::GET, &bob.token, "/friends/requests", None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(requests.incoming.len(), 1);
    let res = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/friends/requests/{}/accept", requests.incoming[0].id),
            None,
        )
        .await;
    assert_eq!(res.status(), 200);

    let friends: Vec<Friend> = server
        .req(reqwest::Method::GET, &alice.token, "/friends", None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(friends.len(), 1);
    assert_eq!(friends[0].user.username, "bob");

    // Carol → Alice, then Alice → Carol auto-accepts the reverse request.
    let res = server
        .req(
            reqwest::Method::POST,
            &carol.token,
            "/friends/requests",
            Some(json!({"username": "alice"})),
        )
        .await;
    assert_eq!(res.status(), 200);
    let auto: FriendRequest = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            "/friends/requests",
            Some(json!({"username": "carol"})),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(auto.from.username, "carol");
    let friends: Vec<Friend> = server
        .req(reqwest::Method::GET, &alice.token, "/friends", None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(friends.len(), 2);

    // DM: open twice → same channel; non-friends (bob↔carol) forbidden.
    let dm: DmChannel = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/dms/{}", bob.user.id.0),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    let dm2: DmChannel = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/dms/{}", alice.user.id.0),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(dm.channel_id, dm2.channel_id);
    let res = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/dms/{}", carol.user.id.0),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);

    // Messages flow through the DM channel; outsiders can't read.
    let res = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/channels/{}/messages", dm.channel_id.0),
            Some(json!({"content": "psst bob", "reply_to_id": null, "attachment_ids": []})),
        )
        .await;
    assert_eq!(res.status(), 200);
    let history: Vec<Message> = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/channels/{}/messages", dm.channel_id.0),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    let res = server
        .req(
            reqwest::Method::GET,
            &carol.token,
            &format!("/channels/{}/messages", dm.channel_id.0),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);

    // Unfriend: DM opening now refused.
    let res = server
        .req(
            reqwest::Method::DELETE,
            &alice.token,
            &format!("/friends/{}", bob.user.id.0),
            None,
        )
        .await;
    assert_eq!(res.status(), 204);
    let res = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/dms/{}", bob.user.id.0),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);
}
