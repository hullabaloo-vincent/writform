//! Canvas boards: create/list, element CRUD with LWW updates, connector
//! validation, permission boundary (non-members rejected), delete rules.

use serde_json::json;
use writform_proto::api::AuthResponse;
use writform_proto::canvas::{BoardDetail, CanvasBoard, CanvasElement};
use writform_server::routes;

struct TestServer {
    base: String,
    client: reqwest::Client,
}

async fn boot() -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let state = routes::AppState::with_data_dir("C".into(), pool, b"pk", b"sig", dir.keep());
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
async fn canvas_end_to_end() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let mallory = server.register("mallory").await;

    // Alice creates a group; Bob joins by invite; Mallory stays outside.
    let group: serde_json::Value = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            "/groups",
            Some(json!({"name": "Writers"})),
        )
        .await
        .json()
        .await
        .unwrap();
    let group_id = group["id"].as_i64().unwrap();
    let invite: serde_json::Value = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/groups/{group_id}/invites"),
            Some(json!({})),
        )
        .await
        .json()
        .await
        .unwrap();
    let res = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            "/invites/redeem",
            Some(json!({"code": invite["code"]})),
        )
        .await;
    assert!(res.status().is_success());

    // Board creation + listing.
    let board: CanvasBoard = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/groups/{group_id}/boards"),
            Some(json!({"name": "Act One"})),
        )
        .await
        .json()
        .await
        .unwrap();
    let boards: Vec<CanvasBoard> = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/groups/{group_id}/boards"),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(boards.len(), 1);

    // Non-members can neither list boards nor read the board.
    let res = server
        .req(
            reqwest::Method::GET,
            &mallory.token,
            &format!("/groups/{group_id}/boards"),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);
    let res = server
        .req(
            reqwest::Method::GET,
            &mallory.token,
            &format!("/boards/{}", board.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);

    // Elements: sticky + text, then a connector between them.
    let sticky: CanvasElement = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/boards/{}/elements", board.id),
            Some(json!({
                "kind": "sticky", "x": 100.0, "y": 80.0, "w": 180.0, "h": 140.0,
                "text": "Ishmael goes to sea", "color": "yellow",
                "from_id": null, "to_id": null
            })),
        )
        .await
        .json()
        .await
        .unwrap();
    let text: CanvasElement = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/boards/{}/elements", board.id),
            Some(json!({
                "kind": "text", "x": 400.0, "y": 90.0, "w": 220.0, "h": 60.0,
                "text": "Chapter 1", "color": "",
                "from_id": null, "to_id": null
            })),
        )
        .await
        .json()
        .await
        .unwrap();

    // Connector endpoints must exist on the board.
    let res = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/boards/{}/elements", board.id),
            Some(json!({
                "kind": "connector", "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0,
                "text": "", "color": "", "from_id": sticky.id, "to_id": 999999
            })),
        )
        .await;
    assert_eq!(res.status(), 400);
    let connector: CanvasElement = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/boards/{}/elements", board.id),
            Some(json!({
                "kind": "connector", "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0,
                "text": "", "color": "", "from_id": sticky.id, "to_id": text.id
            })),
        )
        .await
        .json()
        .await
        .unwrap();

    // LWW partial update: Bob moves Alice's sticky, text untouched.
    let moved: CanvasElement = server
        .req(
            reqwest::Method::PATCH,
            &bob.token,
            &format!("/elements/{}", sticky.id),
            Some(json!({"x": 250.0, "y": 120.0})),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(moved.x, 250.0);
    assert_eq!(moved.text, "Ishmael goes to sea");
    assert_eq!(moved.updated_by.0, bob.user.id.0);

    // Mallory cannot touch elements.
    let res = server
        .req(
            reqwest::Method::PATCH,
            &mallory.token,
            &format!("/elements/{}", sticky.id),
            Some(json!({"x": 0.0})),
        )
        .await;
    assert_eq!(res.status(), 403);

    // Deleting an endpoint also removes connectors attached to it.
    let res = server
        .req(
            reqwest::Method::DELETE,
            &alice.token,
            &format!("/elements/{}", text.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 204);
    let detail: BoardDetail = server
        .req(
            reqwest::Method::GET,
            &alice.token,
            &format!("/boards/{}", board.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail.elements.len(), 1);
    assert!(detail.elements.iter().all(|e| e.id != connector.id));

    // Bob (member, not admin, not creator) cannot delete the board…
    let res = server
        .req(
            reqwest::Method::DELETE,
            &bob.token,
            &format!("/boards/{}", board.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);
    // …but the creator can.
    let res = server
        .req(
            reqwest::Method::DELETE,
            &alice.token,
            &format!("/boards/{}", board.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 204);
}
