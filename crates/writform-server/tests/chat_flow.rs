//! Integration test of the chat stack: groups, invites, channels, messages,
//! permissions, and WS fan-out with presence — two real users over a bound
//! listener (plain HTTP; TLS is covered by tls_identity.rs).

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use writform_proto::api::AuthResponse;
use writform_proto::chat::{Channel, Group, Invite, Message};
use writform_proto::ws::{ClientFrame, ServerFrame};
use writform_server::routes;

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
        routes::AppState::with_data_dir("Chat Test".into(), pool, b"pk", b"sig", dir.keep());
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

    async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
        body: serde_json::Value,
    ) -> T {
        let res = self
            .client
            .post(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "POST {path}: {}", res.status());
        res.json().await.unwrap()
    }

    /// POST returning the raw response, for asserting status codes.
    async fn post_json_raw(
        &self,
        token: &str,
        path: &str,
        body: serde_json::Value,
    ) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, token: &str, path: &str) -> T {
        let res = self
            .client
            .get(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "GET {path}: {}", res.status());
        res.json().await.unwrap()
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
    // Expect ready.
    let ready = next_frame(&mut ws).await;
    assert!(
        matches!(ready, ServerFrame::Ready { .. }),
        "expected ready, got {ready:?}"
    );
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

/// Wait for a specific event kind, skipping others (presence noise etc.).
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
async fn group_chat_end_to_end() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;

    // Alice creates a group (gets #general automatically).
    let group: Group = server
        .post_json(&alice.token, "/groups", json!({"name": "Writers Guild"}))
        .await;
    let channels: Vec<Channel> = server
        .get_json(&alice.token, &format!("/groups/{}/channels", group.id.0))
        .await;
    assert_eq!(channels.len(), 1);
    let general = channels[0].id;

    // Bob can't see the group's channels before joining.
    let res = server
        .client
        .get(format!("{}/groups/{}/channels", server.base, group.id.0))
        .bearer_auth(&bob.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);

    // Invite → redeem.
    let invite: Invite = server
        .post_json(
            &alice.token,
            &format!("/groups/{}/invites", group.id.0),
            json!({"expires_in_seconds": 3600, "max_uses": 5}),
        )
        .await;
    let joined: Group = server
        .post_json(&bob.token, "/invites/redeem", json!({"code": invite.code}))
        .await;
    assert_eq!(joined.id, group.id);

    // Both subscribe to the channel; bob also watches the group room.
    let mut alice_ws = ws_connect(
        &server,
        &alice.token,
        &[
            format!("channel:{}", general.0),
            format!("group:{}", group.id.0),
        ],
    )
    .await;
    let bob_ws = ws_connect(&server, &bob.token, &[format!("channel:{}", general.0)]).await;

    // Bob sends a message; Alice receives it via fan-out.
    let sent: Message = server
        .post_json(
            &bob.token,
            &format!("/channels/{}/messages", general.0),
            json!({"content": "hello from bob!", "reply_to_id": null, "attachment_ids": []}),
        )
        .await;
    let event = wait_for_event(&mut alice_ws, "message.created").await;
    assert_eq!(event["id"], sent.id.0);
    assert_eq!(event["content"], "hello from bob!");
    assert_eq!(event["author"]["username"], "bob");

    // History via REST agrees.
    let history: Vec<Message> = server
        .get_json(&alice.token, &format!("/channels/{}/messages", general.0))
        .await;
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].content.as_deref(), Some("hello from bob!"));

    // Member (bob) cannot create channels; admin (alice) can.
    let res = server
        .client
        .post(format!("{}/groups/{}/channels", server.base, group.id.0))
        .bearer_auth(&bob.token)
        .json(&json!({"name": "writing-room"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let _room: Channel = server
        .post_json(
            &alice.token,
            &format!("/groups/{}/channels", group.id.0),
            json!({"name": "Writing Room"}),
        )
        .await;
    let event = wait_for_event(&mut alice_ws, "channel.created").await;
    assert_eq!(event["name"], "writing-room");

    // Kick: bob loses membership and can no longer read messages.
    let res = server
        .client
        .delete(format!(
            "{}/groups/{}/members/{}",
            server.base, group.id.0, bob.user.id.0
        ))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let event = wait_for_event(&mut alice_ws, "member.left").await;
    assert_eq!(event["user_id"], bob.user.id.0);

    let res = server
        .client
        .get(format!("{}/channels/{}/messages", server.base, general.0))
        .bearer_auth(&bob.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);

    drop(bob_ws);
}

#[tokio::test]
async fn ws_rejects_forbidden_rooms_and_presence_flows() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let mallory = server.register("mallory").await;

    let group: Group = server
        .post_json(&alice.token, "/groups", json!({"name": "Private"}))
        .await;

    // Mallory (not a member) subscribes to the group room → forbidden error.
    let mut mallory_ws = ws_connect(&server, &mallory.token, &[]).await;
    let sub = serde_json::to_string(&ClientFrame::Sub {
        rooms: vec![format!("group:{}", group.id.0)],
    })
    .unwrap();
    mallory_ws.send(WsMsg::Text(sub.into())).await.unwrap();
    let frame = next_frame(&mut mallory_ws).await;
    match frame {
        ServerFrame::Error { code, .. } => assert_eq!(code, "forbidden_room"),
        other => panic!("expected error frame, got {other:?}"),
    }

    // Alice watches her group; when she reconnects as a second device nothing
    // fires, but presence snapshot shows her online.
    let _alice_ws = ws_connect(&server, &alice.token, &[format!("group:{}", group.id.0)]).await;
    let presence: writform_proto::chat::PresenceSnapshot = server
        .get_json(&alice.token, &format!("/groups/{}/presence", group.id.0))
        .await;
    assert_eq!(presence.online, vec![alice.user.id]);
}

/// A member must see OTHER connected members in the presence snapshot, and
/// receive live `presence.update` events for them. The older presence test
/// only covered a user seeing themselves, which hid whether cross-user
/// presence worked at all.
#[tokio::test]
async fn presence_reports_other_members() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;

    let group: Group = server
        .post_json(&alice.token, "/groups", json!({"name": "Writers"}))
        .await;
    let invite: Invite = server
        .post_json(
            &alice.token,
            &format!("/groups/{}/invites", group.id.0),
            json!({"expires_in_seconds": 3600, "max_uses": 5}),
        )
        .await;
    let _: Group = server
        .post_json(&bob.token, "/invites/redeem", json!({"code": invite.code}))
        .await;

    // Alice watches the group room; nobody else is connected yet.
    let mut alice_ws = ws_connect(&server, &alice.token, &[format!("group:{}", group.id.0)]).await;
    let presence: writform_proto::chat::PresenceSnapshot = server
        .get_json(&alice.token, &format!("/groups/{}/presence", group.id.0))
        .await;
    assert_eq!(presence.online, vec![alice.user.id]);
    assert!(!presence.online.contains(&bob.user.id));

    // Bob connects: alice must be told, and the snapshot must include him.
    let _bob_ws = ws_connect(&server, &bob.token, &[]).await;
    let ev = wait_for_event(&mut alice_ws, "presence.update").await;
    assert_eq!(ev["user_id"].as_i64().unwrap(), bob.user.id.0);
    assert_eq!(ev["online"], true);
    assert_eq!(ev["status"], "online");

    let presence: writform_proto::chat::PresenceSnapshot = server
        .get_json(&alice.token, &format!("/groups/{}/presence", group.id.0))
        .await;
    assert!(
        presence.online.contains(&bob.user.id),
        "bob should be online in the snapshot, got {:?}",
        presence.online
    );

    // Bob goes busy: alice sees the status change, and the snapshot moves him.
    let res = server
        .client
        .put(format!("{}/auth/status", server.base))
        .bearer_auth(&bob.token)
        .json(&json!({"status": "busy"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let ev = wait_for_event(&mut alice_ws, "presence.update").await;
    assert_eq!(ev["user_id"].as_i64().unwrap(), bob.user.id.0);
    assert_eq!(ev["status"], "busy");

    let presence: writform_proto::chat::PresenceSnapshot = server
        .get_json(&alice.token, &format!("/groups/{}/presence", group.id.0))
        .await;
    assert!(presence.busy.contains(&bob.user.id), "bob should be busy");
    assert!(!presence.online.contains(&bob.user.id));
}

/// Emoji reactions: toggle on/off, tally across users, live fan-out, and the
/// permission boundary (a non-member cannot react).
#[tokio::test]
async fn message_reactions() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let mallory = server.register("mallory").await;

    let group: Group = server
        .post_json(&alice.token, "/groups", json!({"name": "Writers"}))
        .await;
    let invite: Invite = server
        .post_json(
            &alice.token,
            &format!("/groups/{}/invites", group.id.0),
            json!({"expires_in_seconds": 3600, "max_uses": 5}),
        )
        .await;
    let _: Group = server
        .post_json(&bob.token, "/invites/redeem", json!({"code": invite.code}))
        .await;
    let channels: Vec<Channel> = server
        .get_json(&alice.token, &format!("/groups/{}/channels", group.id.0))
        .await;
    let general = channels[0].id;

    let sent: Message = server
        .post_json(
            &alice.token,
            &format!("/channels/{}/messages", general.0),
            json!({"content": "ship it", "reply_to_id": null, "attachment_ids": []}),
        )
        .await;
    assert!(sent.reactions.is_empty());

    let mut bob_ws = ws_connect(&server, &bob.token, &[format!("channel:{}", general.0)]).await;

    // Alice reacts; bob is told.
    let res = server
        .post_json_raw(
            &alice.token,
            &format!("/messages/{}/reactions", sent.id.0),
            json!({"emoji": "🎉"}),
        )
        .await;
    assert_eq!(res.status(), 204);
    let ev = wait_for_event(&mut bob_ws, "message.reactions").await;
    assert_eq!(ev["message_id"].as_i64().unwrap(), sent.id.0);
    assert_eq!(ev["reactions"][0]["emoji"], "🎉");
    assert_eq!(ev["reactions"][0]["count"].as_i64().unwrap(), 1);

    // Re-reacting the same emoji is idempotent, not a double count.
    server
        .post_json_raw(
            &alice.token,
            &format!("/messages/{}/reactions", sent.id.0),
            json!({"emoji": "🎉"}),
        )
        .await;
    // Bob adds the same emoji: the tally goes to 2 and `me` is per-viewer.
    server
        .post_json_raw(
            &bob.token,
            &format!("/messages/{}/reactions", sent.id.0),
            json!({"emoji": "🎉"}),
        )
        .await;
    let history: Vec<Message> = server
        .get_json(&bob.token, &format!("/channels/{}/messages", general.0))
        .await;
    let reactions = &history[0].reactions;
    assert_eq!(reactions.len(), 1);
    assert_eq!(reactions[0].count, 2, "alice + bob, not a double-count");
    assert!(reactions[0].me, "bob reacted, so `me` is true for bob");

    let history_for_mallory_view: Vec<Message> = server
        .get_json(&alice.token, &format!("/channels/{}/messages", general.0))
        .await;
    assert!(
        history_for_mallory_view[0].reactions[0].me,
        "alice also reacted"
    );

    // Non-members cannot react.
    let res = server
        .post_json_raw(
            &mallory.token,
            &format!("/messages/{}/reactions", sent.id.0),
            json!({"emoji": "🎉"}),
        )
        .await;
    assert_eq!(res.status(), 403);

    // Non-emoji payloads are rejected.
    let res = server
        .post_json_raw(
            &alice.token,
            &format!("/messages/{}/reactions", sent.id.0),
            json!({"emoji": "lgtm"}),
        )
        .await;
    assert_eq!(res.status(), 400);

    // Removing only removes your own; bob's stays.
    let res = server
        .client
        .delete(format!(
            "{}/messages/{}/reactions/{}",
            server.base,
            sent.id.0,
            urlencoding_emoji("🎉")
        ))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let history: Vec<Message> = server
        .get_json(&bob.token, &format!("/channels/{}/messages", general.0))
        .await;
    assert_eq!(history[0].reactions[0].count, 1);
    assert!(history[0].reactions[0].me, "bob's own reaction remains");
}

fn urlencoding_emoji(s: &str) -> String {
    s.bytes().map(|b| format!("%{b:02X}")).collect()
}
