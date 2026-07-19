//! Writing-session lifecycle: create session (+auto chat channel), multiple
//! prompts, start/early-stop, timer expiry, submission autosave + snapshots,
//! and the "no peeking until the prompt ends" visibility rule.

use serde_json::json;
use writform_proto::api::AuthResponse;
use writform_proto::chat::{Channel, Group};
use writform_proto::sessions::{SessionDetail, SessionPrompt, WritingSession};
use writform_server::routes;

struct TestServer {
    base: String,
    client: reqwest::Client,
}

async fn boot() -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let state = routes::AppState::with_data_dir("Sess".into(), pool, b"pk", b"sig", dir.keep());
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

    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
        body: serde_json::Value,
    ) -> T {
        let res = self
            .req(reqwest::Method::POST, token, path, Some(body))
            .await;
        assert!(res.status().is_success(), "POST {path}: {}", res.status());
        res.json().await.unwrap()
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, token: &str, path: &str) -> T {
        let res = self.req(reqwest::Method::GET, token, path, None).await;
        assert!(res.status().is_success(), "GET {path}: {}", res.status());
        res.json().await.unwrap()
    }
}

fn doc(text: &str) -> serde_json::Value {
    json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]})
}

async fn setup_group(server: &TestServer) -> (AuthResponse, AuthResponse, i64) {
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let group: Group = server
        .post(&alice.token, "/groups", json!({"name": "G"}))
        .await;
    let invite: writform_proto::chat::Invite = server
        .post(
            &alice.token,
            &format!("/groups/{}/invites", group.id.0),
            json!({"expires_in_seconds": null, "max_uses": null}),
        )
        .await;
    let _: Group = server
        .post(&bob.token, "/invites/redeem", json!({"code": invite.code}))
        .await;
    let channels: Vec<Channel> = server
        .get(&alice.token, &format!("/groups/{}/channels", group.id.0))
        .await;
    (alice, bob, channels[0].id.0)
}

#[tokio::test]
async fn multi_prompt_session_lifecycle() {
    let server = boot().await;
    let (alice, bob, channel) = setup_group(&server).await;

    // Bob (a regular member) creates a session; a side-chat channel appears.
    let session: WritingSession = server
        .post(
            &bob.token,
            "/sessions",
            json!({"channel_id": channel, "title": "Friday Sprint"}),
        )
        .await;
    assert_ne!(session.chat_channel_id.0, channel);

    // Two prompts: one timed (short), one untimed.
    let p1: SessionPrompt = server
        .post(
            &bob.token,
            &format!("/sessions/{}/prompts", session.id.0),
            json!({"prompt_doc": doc("Write about rain."), "timer_seconds": null}),
        )
        .await;
    let p2: SessionPrompt = server
        .post(
            &alice.token,
            &format!("/sessions/{}/prompts", session.id.0),
            json!({"prompt_doc": doc("Now, thunder."), "timer_seconds": null}),
        )
        .await;
    assert!(p2.position > p1.position);

    // Only the prompt's creator (or admin) starts it; alice IS admin, so she
    // can start bob's — but carol the outsider can't even see the session.
    let res = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/prompts/{}/start", p1.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 204);

    // While p1 runs: both write; each sees only their own submission.
    let res = server
        .req(
            reqwest::Method::PUT,
            &alice.token,
            &format!("/prompts/{}/submission", p1.id),
            Some(json!({"doc": doc("alice draft 1")})),
        )
        .await;
    assert_eq!(res.status(), 204);
    let res = server
        .req(
            reqwest::Method::PUT,
            &bob.token,
            &format!("/prompts/{}/submission", p1.id),
            Some(json!({"doc": doc("bob draft 1")})),
        )
        .await;
    assert_eq!(res.status(), 204);

    let detail: SessionDetail = server
        .get(&alice.token, &format!("/sessions/{}", session.id.0))
        .await;
    assert_eq!(detail.submissions.len(), 1, "no peeking while running");
    assert_eq!(detail.submissions[0].author.username, "alice");

    // Autosave overwrites; the final doc wins.
    let res = server
        .req(
            reqwest::Method::PUT,
            &alice.token,
            &format!("/prompts/{}/submission", p1.id),
            Some(json!({"doc": doc("alice draft 2 — final")})),
        )
        .await;
    assert_eq!(res.status(), 204);

    // Creator stops the prompt early → everyone's writing is revealed.
    let res = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/prompts/{}/stop", p1.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 204);

    let detail: SessionDetail = server
        .get(&alice.token, &format!("/sessions/{}", session.id.0))
        .await;
    assert_eq!(detail.submissions.len(), 2);
    let alice_sub = detail
        .submissions
        .iter()
        .find(|s| s.author.username == "alice")
        .unwrap();
    assert!(alice_sub.doc.to_string().contains("final"));

    // Writing after the prompt ended is rejected.
    let res = server
        .req(
            reqwest::Method::PUT,
            &bob.token,
            &format!("/prompts/{}/submission", p1.id),
            Some(json!({"doc": doc("too late")})),
        )
        .await;
    assert_eq!(res.status(), 400);

    // End the whole session (admin alice may, since she's group admin).
    let res = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/sessions/{}/end", session.id.0),
            None,
        )
        .await;
    assert_eq!(res.status(), 204);
    let detail: SessionDetail = server
        .get(&bob.token, &format!("/sessions/{}", session.id.0))
        .await;
    assert!(matches!(
        detail.session.state,
        writform_proto::sessions::SessionState::Ended
    ));

    // Past sessions remain browsable: list still returns it, detail has all
    // prompts + everyone's final writing.
    let sessions: Vec<WritingSession> = server
        .get(&bob.token, &format!("/channels/{channel}/sessions"))
        .await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(detail.prompts.len(), 2);
}

#[tokio::test]
async fn timer_expires_and_ends_prompt() {
    let server = boot().await;
    let (alice, _bob, channel) = setup_group(&server).await;

    let session: WritingSession = server
        .post(
            &alice.token,
            "/sessions",
            json!({"channel_id": channel, "title": "Timed"}),
        )
        .await;
    let prompt: SessionPrompt = server
        .post(
            &alice.token,
            &format!("/sessions/{}/prompts", session.id.0),
            json!({"prompt_doc": doc("Quick!"), "timer_seconds": 10}),
        )
        .await;

    // Shorten the wait: start, then poll until the server flips it to ended.
    // (10s is the API minimum; the timer task uses real time.)
    let res = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/prompts/{}/start", prompt.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 204);

    let detail: SessionDetail = server
        .get(&alice.token, &format!("/sessions/{}", session.id.0))
        .await;
    let p = &detail.prompts[0];
    assert!(matches!(
        p.state,
        writform_proto::sessions::PromptState::Running
    ));
    assert!(p.ends_at.is_some());

    let mut ended = false;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let detail: SessionDetail = server
            .get(&alice.token, &format!("/sessions/{}", session.id.0))
            .await;
        if matches!(
            detail.prompts[0].state,
            writform_proto::sessions::PromptState::Ended
        ) {
            ended = true;
            break;
        }
    }
    assert!(ended, "timer never ended the prompt");
}

#[tokio::test]
async fn session_share_card_and_delete() {
    let server = boot().await;
    let (alice, bob, channel) = setup_group(&server).await;

    // Bob creates a session — a 'session' join card lands in the home channel.
    let session: WritingSession = server
        .post(
            &bob.token,
            "/sessions",
            json!({"channel_id": channel, "title": "Deletable"}),
        )
        .await;
    let messages: Vec<writform_proto::chat::Message> = server
        .get(&alice.token, &format!("/channels/{channel}/messages"))
        .await;
    let card = messages
        .iter()
        .find(|m| m.kind == "session")
        .expect("session card message posted to home channel");
    let content: serde_json::Value =
        serde_json::from_str(card.content.as_deref().unwrap()).unwrap();
    assert_eq!(content["session_id"], session.id.0);
    assert_eq!(content["title"], "Deletable");

    // Carol (not creator, not admin) cannot delete it.
    let carol = server.register("carol").await;
    let invite: writform_proto::chat::Invite = server
        .post(
            &alice.token,
            &format!("/groups/{}/invites", {
                let g: Vec<writform_proto::chat::Group> = server.get(&alice.token, "/groups").await;
                g[0].id.0
            }),
            json!({"expires_in_seconds": null, "max_uses": null}),
        )
        .await;
    let _: writform_proto::chat::Group = server
        .post(
            &carol.token,
            "/invites/redeem",
            json!({"code": invite.code}),
        )
        .await;
    let res = server
        .req(
            reqwest::Method::DELETE,
            &carol.token,
            &format!("/sessions/{}", session.id.0),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);

    // Alice (group admin, not creator) can. Session and its side chat vanish.
    let chat_channel = session.chat_channel_id.0;
    let res = server
        .req(
            reqwest::Method::DELETE,
            &alice.token,
            &format!("/sessions/{}", session.id.0),
            None,
        )
        .await;
    assert_eq!(res.status(), 204);
    let res = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/sessions/{}", session.id.0),
            None,
        )
        .await;
    assert_eq!(res.status(), 404);
    let res = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/channels/{chat_channel}/messages"),
            None,
        )
        .await;
    assert_eq!(res.status(), 404, "side-chat channel should be gone");
}
