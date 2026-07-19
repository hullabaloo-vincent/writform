//! Voice rooms: channel CRUD permissions, join/leave presence with WS
//! fan-out, signal relay between members, non-member rejection, and
//! auto-leave when a user's last socket disconnects.

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use writform_proto::api::AuthResponse;
use writform_proto::chat::Group;
use writform_proto::voice::{VoiceChannel, VoiceChannelInfo, VoiceJoinResponse};
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
    let state =
        routes::AppState::with_data_dir("Voice Test".into(), pool, b"pk", b"sig", dir.keep());
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

    async fn post(&self, token: &str, path: &str, body: serde_json::Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
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

#[tokio::test]
async fn voice_end_to_end() {
    let server = boot().await;
    let alice = server.register("alice").await; // group admin
    let bob = server.register("bob").await;
    let mallory = server.register("mallory").await; // not a member

    let group: Group = server
        .post(&alice.token, "/groups", json!({"name": "Writers"}))
        .await
        .json()
        .await
        .unwrap();
    let invite: serde_json::Value = server
        .post(
            &alice.token,
            &format!("/groups/{}/invites", group.id.0),
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(server
        .post(
            &bob.token,
            "/invites/redeem",
            json!({"code": invite["code"]})
        )
        .await
        .status()
        .is_success());

    // Members can't create voice channels; the admin can.
    let res = server
        .post(
            &bob.token,
            &format!("/groups/{}/voice", group.id.0),
            json!({"name": "Lounge"}),
        )
        .await;
    assert_eq!(res.status(), 403);
    let lounge: VoiceChannel = server
        .post(
            &alice.token,
            &format!("/groups/{}/voice", group.id.0),
            json!({"name": "Lounge"}),
        )
        .await
        .json()
        .await
        .unwrap();

    // Sockets watching the group room see joins/leaves.
    let group_room = vec![format!("group:{}", group.id.0)];
    let mut alice_ws = ws_connect(&server, &alice.token, &group_room).await;
    let mut bob_ws = ws_connect(&server, &bob.token, &group_room).await;

    // Mallory can neither list nor join.
    let res = server
        .post(
            &mallory.token,
            &format!("/voice/{}/join", lounge.id),
            json!({}),
        )
        .await;
    assert_eq!(res.status(), 403);

    // Alice joins an empty room.
    let joined: VoiceJoinResponse = server
        .post(
            &alice.token,
            &format!("/voice/{}/join", lounge.id),
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(joined.participants.is_empty());
    let ev = wait_for_event(&mut bob_ws, "voice.joined").await;
    assert_eq!(ev["user"]["username"], "alice");

    // Bob joins and is told Alice is already there.
    let joined: VoiceJoinResponse = server
        .post(&bob.token, &format!("/voice/{}/join", lounge.id), json!({}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(joined.participants.len(), 1);
    assert_eq!(joined.participants[0].username, "alice");
    wait_for_event(&mut alice_ws, "voice.joined").await;

    // Listing shows both participants.
    let info: Vec<VoiceChannelInfo> = server
        .client
        .get(format!("{}/groups/{}/voice", server.base, group.id.0))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info[0].participants.len(), 2);

    // Signal relay: Bob → Alice lands on Alice's user room.
    assert!(server
        .post(
            &bob.token,
            &format!("/voice/{}/signal", lounge.id),
            json!({"to": alice.user.id, "data": {"type": "offer", "sdp": "v=0 test"}}),
        )
        .await
        .status()
        .is_success());
    let sig = wait_for_event(&mut alice_ws, "voice.signal").await;
    assert_eq!(sig["from"], alice.user.id.0 + 1); // bob registered second
    assert_eq!(sig["data"]["type"], "offer");

    // Signaling to someone outside the room is rejected.
    let res = server
        .post(
            &bob.token,
            &format!("/voice/{}/signal", lounge.id),
            json!({"to": mallory.user.id, "data": {"type": "offer"}}),
        )
        .await;
    assert_eq!(res.status(), 400);

    // Explicit leave broadcasts voice.left.
    assert!(server
        .post(&alice.token, "/voice/leave", json!({}))
        .await
        .status()
        .is_success());
    let ev = wait_for_event(&mut bob_ws, "voice.left").await;
    assert_eq!(ev["user_id"], alice.user.id.0);

    // Auto-leave: Bob's last socket drops → voice.left for Bob.
    drop(bob_ws);
    let ev = wait_for_event(&mut alice_ws, "voice.left").await;
    assert_eq!(ev["channel_id"], lounge.id);
}
