//! Canvas boards: create/list, element CRUD with LWW updates, connector
//! validation, permission boundary (non-members rejected), delete rules,
//! board-image attachment access, and live WS fan-out between members.

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use writform_proto::api::AuthResponse;
use writform_proto::canvas::{BoardDetail, CanvasBoard, CanvasElement};
use writform_proto::ws::{ClientFrame, ServerFrame};
use writform_server::routes;

use tokio_tungstenite::tungstenite::Message as WsMsg;

struct TestServer {
    base: String,
    ws_base: String,
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
        ws_base: format!("ws://127.0.0.1:{}/api/v1/ws", addr.port()),
        client: reqwest::Client::new(),
    }
}

type WsConn =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn ws_connect(server: &TestServer, token: &str, rooms: &[String]) -> WsConn {
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.ws_base)
        .await
        .unwrap();
    let auth = serde_json::to_string(&ClientFrame::Auth {
        token: token.into(),
        protocol_version: writform_proto::PROTOCOL_VERSION,
    })
    .unwrap();
    ws.send(WsMsg::Text(auth.into())).await.unwrap();
    let ready = next_frame(&mut ws).await;
    assert!(matches!(ready, ServerFrame::Ready { .. }));
    if !rooms.is_empty() {
        let sub = serde_json::to_string(&ClientFrame::Sub {
            rooms: rooms.to_vec(),
        })
        .unwrap();
        ws.send(WsMsg::Text(sub.into())).await.unwrap();
    }
    ws
}

/// Sub frames are processed in order per connection: sending a malformed Sub
/// and waiting for its `bad_room` error proves every earlier Sub is live.
async fn sync_subs(ws: &mut WsConn) {
    let sub = serde_json::to_string(&ClientFrame::Sub {
        rooms: vec!["nonsense".into()],
    })
    .unwrap();
    ws.send(WsMsg::Text(sub.into())).await.unwrap();
    loop {
        if let ServerFrame::Error { code, .. } = next_frame(ws).await {
            assert_eq!(code, "bad_room");
            return;
        }
    }
}

async fn next_frame(ws: &mut WsConn) -> ServerFrame {
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for ws frame")
            .expect("socket closed")
            .unwrap();
        if let WsMsg::Text(text) = msg {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

async fn wait_for_event(ws: &mut WsConn, want: &str) -> serde_json::Value {
    for _ in 0..20 {
        if let ServerFrame::Event { kind, data, .. } = next_frame(ws).await {
            if kind == want {
                return data;
            }
        }
    }
    panic!("event {want} never arrived");
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

/// Shared setup: alice's group with bob as member, mallory outside, one board.
async fn group_with_board(
    server: &TestServer,
    alice: &AuthResponse,
    bob: &AuthResponse,
) -> (i64, CanvasBoard) {
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
    let board: CanvasBoard = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/groups/{group_id}/boards"),
            Some(json!({"name": "Shared"})),
        )
        .await
        .json()
        .await
        .unwrap();
    (group_id, board)
}

#[tokio::test]
async fn board_image_attachment_visible_to_members() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let mallory = server.register("mallory").await;
    let (_group_id, board) = group_with_board(&server, &alice, &bob).await;

    // Alice uploads an image and pastes it onto the board.
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0])
            .file_name("paste.png"),
    );
    let att: serde_json::Value = server
        .client
        .post(format!("{}/attachments", server.base))
        .bearer_auth(&alice.token)
        .multipart(form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let att_id = att["id"].as_i64().unwrap();

    // Before the element exists, bob has no path to the attachment.
    let res = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/attachments/{att_id}"),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);

    let _el: CanvasElement = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/boards/{}/elements", board.id),
            Some(json!({
                "kind": "image", "x": 10.0, "y": 10.0, "w": 320.0, "h": 200.0,
                "text": att_id.to_string(), "color": "",
                "from_id": null, "to_id": null
            })),
        )
        .await
        .json()
        .await
        .unwrap();

    // Group members can now fetch it; outsiders still cannot.
    let res = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/attachments/{att_id}"),
            None,
        )
        .await;
    assert_eq!(res.status(), 200);
    let res = server
        .req(
            reqwest::Method::GET,
            &mallory.token,
            &format!("/attachments/{att_id}"),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);
}

#[tokio::test]
async fn canvas_ws_fanout_between_members() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let mallory = server.register("mallory").await;
    let (_group_id, board) = group_with_board(&server, &alice, &bob).await;
    let room = format!("canvas:{}", board.id);

    // A non-member's Sub is rejected.
    let mut mallory_ws = ws_connect(&server, &mallory.token, std::slice::from_ref(&room)).await;
    match next_frame(&mut mallory_ws).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "forbidden_room"),
        other => panic!("expected forbidden_room error, got {other:?}"),
    }

    // Bob subscribes and sees alice's create + move live.
    let mut bob_ws = ws_connect(&server, &bob.token, std::slice::from_ref(&room)).await;
    sync_subs(&mut bob_ws).await;
    let created: CanvasElement = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/boards/{}/elements", board.id),
            Some(json!({
                "kind": "sticky", "x": 50.0, "y": 60.0, "w": 180.0, "h": 140.0,
                "text": "live?", "color": "yellow",
                "from_id": null, "to_id": null
            })),
        )
        .await
        .json()
        .await
        .unwrap();
    let ev = wait_for_event(&mut bob_ws, "canvas.element.created").await;
    assert_eq!(ev["id"].as_i64().unwrap(), created.id);
    assert_eq!(ev["text"].as_str().unwrap(), "live?");

    let _moved: CanvasElement = server
        .req(
            reqwest::Method::PATCH,
            &alice.token,
            &format!("/elements/{}", created.id),
            Some(json!({"x": 300.0})),
        )
        .await
        .json()
        .await
        .unwrap();
    let ev = wait_for_event(&mut bob_ws, "canvas.element.updated").await;
    assert_eq!(ev["id"].as_i64().unwrap(), created.id);
    assert_eq!(ev["x"].as_f64().unwrap(), 300.0);
}

/// A text edit must survive a concurrent update from someone else.
///
/// Clicking any element rewrites its `z` and broadcasts it, so while one
/// person is typing the other's clicks stream in. This pins the server half:
/// a `text`-only PATCH must not be clobbered by an interleaved `z` PATCH on
/// another element, and the response must carry the new text.
#[tokio::test]
async fn text_edit_survives_concurrent_updates() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let (_group_id, board) = group_with_board(&server, &alice, &bob).await;

    let sticky: CanvasElement = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/boards/{}/elements", board.id),
            Some(json!({
                "kind": "sticky", "x": 0.0, "y": 0.0, "w": 180.0, "h": 140.0,
                "text": "", "color": "yellow", "style": "",
                "from_id": null, "to_id": null
            })),
        )
        .await
        .json()
        .await
        .unwrap();
    let other: CanvasElement = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/boards/{}/elements", board.id),
            Some(json!({
                "kind": "sticky", "x": 300.0, "y": 0.0, "w": 180.0, "h": 140.0,
                "text": "bob's", "color": "blue", "style": "",
                "from_id": null, "to_id": null
            })),
        )
        .await
        .json()
        .await
        .unwrap();

    // Bob clicks his sticky (bring-to-front) while alice types in hers.
    let bumped: CanvasElement = server
        .req(
            reqwest::Method::PATCH,
            &bob.token,
            &format!("/elements/{}", other.id),
            Some(json!({ "z": 50 })),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(bumped.z, 50);

    let typed: CanvasElement = server
        .req(
            reqwest::Method::PATCH,
            &alice.token,
            &format!("/elements/{}", sticky.id),
            Some(json!({ "text": "a line of writing" })),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(typed.text, "a line of writing");
    // A text-only patch must leave everything else alone.
    assert_eq!(typed.color, "yellow");
    assert_eq!(typed.w, 180.0);

    // Bob clicks again afterwards; alice's text must not be rolled back.
    server
        .req(
            reqwest::Method::PATCH,
            &bob.token,
            &format!("/elements/{}", other.id),
            Some(json!({ "z": 51 })),
        )
        .await;
    let detail: BoardDetail = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/boards/{}", board.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    let saved = detail
        .elements
        .iter()
        .find(|e| e.id == sticky.id)
        .expect("sticky still on the board");
    assert_eq!(
        saved.text, "a line of writing",
        "text must persist through other people's updates"
    );
}
