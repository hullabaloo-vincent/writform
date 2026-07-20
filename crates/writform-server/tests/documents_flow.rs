//! Documents: CRUD + permission matrix (owner / friend shares / group
//! shares), Yjs update log with seq catch-up + compaction/truncation,
//! version snapshots, feedback threads, share chat card, and WS fan-out.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use writform_proto::api::AuthResponse;
use writform_proto::documents::{
    Document, DocumentActivity, DocumentDetail, DocumentListItem, DocumentThread, DocumentUpdateBatch,
    DocumentVersion, DocumentVersionMeta,
};
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
    let state = routes::AppState::with_data_dir("D".into(), pool, b"pk", b"sig", dir.keep());
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

    async fn befriend(&self, a: &AuthResponse, b: &AuthResponse) {
        let res = self
            .req(
                reqwest::Method::POST,
                &a.token,
                "/friends/requests",
                Some(json!({"username": b.user.username})),
            )
            .await;
        assert!(res.status().is_success());
        let requests: serde_json::Value = self
            .req(reqwest::Method::GET, &b.token, "/friends/requests", None)
            .await
            .json()
            .await
            .unwrap();
        let id = requests["incoming"][0]["id"].as_i64().unwrap();
        let res = self
            .req(
                reqwest::Method::POST,
                &b.token,
                &format!("/friends/requests/{id}/accept"),
                None,
            )
            .await;
        assert!(res.status().is_success());
    }
}

/// Append `content` to the shared text of a local yrs doc, returning the
/// v1-encoded update for just that edit (what a yjs client would POST).
fn text_update(doc: &yrs::Doc, content: &str) -> Vec<u8> {
    use yrs::updates::decoder::Decode as _;
    use yrs::{GetString, ReadTxn, StateVector, Text, Transact};
    let _ = StateVector::default(); // silence unused-import lints across yrs versions
    let text = doc.get_or_insert_text("t");
    let before = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let len = text.get_string(&txn).len() as u32;
        text.insert(&mut txn, len, content);
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    // Sanity: what we send must decode as a v1 update.
    yrs::Update::decode_v1(&update).unwrap();
    update
}

/// Decode a full document state (base64 v1 update) and read its text.
fn state_text(state_b64: &str) -> String {
    use yrs::updates::decoder::Decode as _;
    use yrs::{GetString, Transact};
    let bytes = B64.decode(state_b64).unwrap();
    let doc = yrs::Doc::new();
    let text = doc.get_or_insert_text("t");
    {
        let mut txn = doc.transact_mut();
        let update = yrs::Update::decode_v1(&bytes).unwrap();
        txn.apply_update(update).unwrap();
    }
    let out = text.get_string(&doc.transact());
    out
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

/// Sub frames process in order per connection; a malformed follow-up Sub's
/// error acks every earlier Sub.
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
    for _ in 0..30 {
        if let ServerFrame::Event { kind, data, .. } = next_frame(ws).await {
            if kind == want {
                return data;
            }
        }
    }
    panic!("event {want} never arrived");
}

async fn create_doc(server: &TestServer, token: &str, title: &str) -> Document {
    server
        .req(
            reqwest::Method::POST,
            token,
            "/documents",
            Some(json!({"title": title, "format": "none"})),
        )
        .await
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn documents_permissions_and_threads() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let mallory = server.register("mallory").await;

    let doc = create_doc(&server, &alice.token, "Novel").await;
    assert_eq!(doc.format, "none");

    // Private by default: bob sees nothing.
    let res = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/documents/{}", doc.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);
    let list: Vec<DocumentListItem> = server
        .req(reqwest::Method::GET, &bob.token, "/documents", None)
        .await
        .json()
        .await
        .unwrap();
    assert!(list.is_empty());

    // Sharing requires friendship.
    let res = server
        .req(
            reqwest::Method::PUT,
            &alice.token,
            &format!("/documents/{}/shares", doc.id),
            Some(json!({"subject_kind": "user", "subject_id": bob.user.id.0, "access": "read"})),
        )
        .await;
    assert_eq!(res.status(), 403);
    server.befriend(&alice, &bob).await;
    let res = server
        .req(
            reqwest::Method::PUT,
            &alice.token,
            &format!("/documents/{}/shares", doc.id),
            Some(json!({"subject_kind": "user", "subject_id": bob.user.id.0, "access": "read"})),
        )
        .await;
    assert_eq!(res.status(), 200);

    // Read access: detail yes, edits no.
    let detail: DocumentDetail = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/documents/{}", doc.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail.my_access, "read");
    let update = {
        let d = yrs::Doc::new();
        B64.encode(text_update(&d, "bob was here"))
    };
    let res = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/documents/{}/updates", doc.id),
            Some(json!({"update_b64": update})),
        )
        .await;
    assert_eq!(res.status(), 403);

    // …but feedback threads only need read access.
    let thread: DocumentThread = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/documents/{}/threads", doc.id),
            Some(json!({"content": "love this opening", "excerpt": "Chapter 1"})),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(thread.messages.len(), 1);
    let res = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/document-threads/{}/replies", thread.id),
            Some(json!({"content": "thanks!"})),
        )
        .await;
    assert_eq!(res.status(), 200);
    // Outsiders can't read or comment.
    let res = server
        .req(
            reqwest::Method::GET,
            &mallory.token,
            &format!("/documents/{}/threads", doc.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);
    // Resolve: doc owner may, a mere reader who isn't the author may not.
    let res = server
        .req(
            reqwest::Method::PATCH,
            &alice.token,
            &format!("/document-threads/{}", thread.id),
            Some(json!({"resolved": true})),
        )
        .await;
    assert_eq!(res.status(), 200);
    let alice_thread: DocumentThread = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/documents/{}/threads", doc.id),
            Some(json!({"content": "note to self"})),
        )
        .await
        .json()
        .await
        .unwrap();
    let res = server
        .req(
            reqwest::Method::PATCH,
            &bob.token,
            &format!("/document-threads/{}", alice_thread.id),
            Some(json!({"resolved": true})),
        )
        .await;
    assert_eq!(res.status(), 403);

    // Upgrade to write: edits flow.
    let res = server
        .req(
            reqwest::Method::PUT,
            &alice.token,
            &format!("/documents/{}/shares", doc.id),
            Some(json!({"subject_kind": "user", "subject_id": bob.user.id.0, "access": "write"})),
        )
        .await;
    assert_eq!(res.status(), 200);
    let res = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/documents/{}/updates", doc.id),
            Some(json!({"update_b64": update})),
        )
        .await;
    assert_eq!(res.status(), 200);

    // Only the owner manages shares; revocation cuts access.
    let res = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/documents/{}/shares", doc.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);
    let res = server
        .req(
            reqwest::Method::DELETE,
            &alice.token,
            &format!("/documents/{}/shares/user/{}", doc.id, bob.user.id.0),
            None,
        )
        .await;
    assert_eq!(res.status(), 204);
    let res = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/documents/{}", doc.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);

    // Unknown documents 404; unauthenticated 401.
    let res = server
        .req(reqwest::Method::GET, &alice.token, "/documents/99999", None)
        .await;
    assert_eq!(res.status(), 404);
    let res = server
        .req(reqwest::Method::GET, "bad-token", "/documents", None)
        .await;
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn group_share_card_and_access() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let mallory = server.register("mallory").await;

    // Group with bob as member.
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
    server
        .req(
            reqwest::Method::POST,
            &bob.token,
            "/invites/redeem",
            Some(json!({"code": invite["code"]})),
        )
        .await;

    let doc = create_doc(&server, &alice.token, "Shared draft").await;
    // Owner must belong to the group they share with.
    let res = server
        .req(
            reqwest::Method::PUT,
            &mallory.token,
            &format!("/documents/{}/shares", doc.id),
            Some(json!({"subject_kind": "group", "subject_id": group_id, "access": "read"})),
        )
        .await;
    assert!(res.status() == 403 || res.status() == 404);
    let res = server
        .req(
            reqwest::Method::PUT,
            &alice.token,
            &format!("/documents/{}/shares", doc.id),
            Some(json!({"subject_kind": "group", "subject_id": group_id, "access": "write"})),
        )
        .await;
    assert_eq!(res.status(), 200);

    // Member gets write access via the group; outsider gets nothing.
    let detail: DocumentDetail = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/documents/{}", doc.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail.my_access, "write");
    let list: Vec<DocumentListItem> = server
        .req(reqwest::Method::GET, &bob.token, "/documents", None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list.len(), 1);
    let res = server
        .req(
            reqwest::Method::GET,
            &mallory.token,
            &format!("/documents/{}", doc.id),
            None,
        )
        .await;
    assert_eq!(res.status(), 403);

    // The share announced itself as a document card in the group channel.
    let channels: Vec<serde_json::Value> = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/groups/{group_id}/channels"),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    let channel_id = channels[0]["id"].as_i64().unwrap();
    let messages: Vec<serde_json::Value> = server
        .req(
            reqwest::Method::GET,
            &bob.token,
            &format!("/channels/{channel_id}/messages"),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    let card = messages
        .iter()
        .find(|m| m["kind"] == "document")
        .expect("document card posted");
    let content: serde_json::Value =
        serde_json::from_str(card["content"].as_str().unwrap()).unwrap();
    assert_eq!(content["document_id"].as_i64().unwrap(), doc.id);
    assert_eq!(content["access"], "write");
}

#[tokio::test]
async fn updates_seq_catchup_compaction_and_state() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let doc = create_doc(&server, &alice.token, "Log").await;

    // Three updates from one local doc; seqs must be 1, 2, 3.
    let local = yrs::Doc::new();
    for (i, chunk) in ["one ", "two ", "three"].iter().enumerate() {
        let update = B64.encode(text_update(&local, chunk));
        let res: serde_json::Value = server
            .req(
                reqwest::Method::POST,
                &alice.token,
                &format!("/documents/{}/updates", doc.id),
                Some(json!({"update_b64": update})),
            )
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(res["seq"].as_i64().unwrap(), i as i64 + 1);
    }

    // Catch-up from seq 1 returns exactly 2 and 3.
    let batch: DocumentUpdateBatch = server
        .req(
            reqwest::Method::GET,
            &alice.token,
            &format!("/documents/{}/updates?since=1", doc.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(!batch.truncated);
    assert_eq!(
        batch.updates.iter().map(|u| u.seq).collect::<Vec<_>>(),
        vec![2, 3]
    );

    // Detail state is the merged text (yjs<->yrs v1 canary).
    let detail: DocumentDetail = server
        .req(
            reqwest::Method::GET,
            &alice.token,
            &format!("/documents/{}", doc.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail.seq, 3);
    assert_eq!(state_text(&detail.state_b64), "one two three");

    // Garbage updates are rejected.
    let res = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/documents/{}/updates", doc.id),
            Some(json!({"update_b64": B64.encode(b"not an update")})),
        )
        .await;
    assert_eq!(res.status(), 400);

    // Drive past compaction (200) and the prune window (tail 500): after
    // ~700 appends old rows are gone, so a stale `since` reads truncated.
    for i in 0..702 {
        let update = B64.encode(text_update(&local, &format!("w{i} ")));
        server
            .req(
                reqwest::Method::POST,
                &alice.token,
                &format!("/documents/{}/updates", doc.id),
                Some(json!({"update_b64": update})),
            )
            .await;
    }
    let batch: DocumentUpdateBatch = server
        .req(
            reqwest::Method::GET,
            &alice.token,
            &format!("/documents/{}/updates?since=0", doc.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(batch.truncated, "pruned tail must read as truncated");
    assert!(batch.updates.is_empty());
    // A recent `since` still catches up normally…
    let batch: DocumentUpdateBatch = server
        .req(
            reqwest::Method::GET,
            &alice.token,
            &format!("/documents/{}/updates?since=700", doc.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(!batch.truncated);
    assert_eq!(batch.updates.len(), 5);
    // …and the compacted full state still reconstructs every edit.
    let detail: DocumentDetail = server
        .req(
            reqwest::Method::GET,
            &alice.token,
            &format!("/documents/{}", doc.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(detail.seq, 705);
    let text = state_text(&detail.state_b64);
    assert!(text.starts_with("one two three"));
    assert!(text.ends_with("w701 "));
}

#[tokio::test]
async fn snapshots_and_versions() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let doc = create_doc(&server, &alice.token, "Versioned").await;
    let doc_json = json!({"type": "doc", "content": [{"type": "paragraph"}]}).to_string();

    // First auto snapshot inserts; an identical follow-up is skipped.
    let first: Option<DocumentVersionMeta> = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/documents/{}/snapshot", doc.id),
            Some(json!({"doc_json": doc_json})),
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(first.is_some());
    let dup: Option<DocumentVersionMeta> = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/documents/{}/snapshot", doc.id),
            Some(json!({"doc_json": doc_json})),
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(dup.is_none());

    // Named versions always insert.
    let named: Option<DocumentVersionMeta> = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/documents/{}/snapshot", doc.id),
            Some(json!({"doc_json": doc_json, "name": "Draft 1"})),
        )
        .await
        .json()
        .await
        .unwrap();
    let named = named.expect("named versions always insert");
    assert_eq!(named.kind, "named");

    let second_json = json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "New scene"}]}]}).to_string();
    let draft: Option<DocumentVersionMeta> = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/documents/{}/snapshot", doc.id),
            Some(json!({"doc_json": second_json, "name": "First draft", "kind": "draft"})),
        )
        .await
        .json()
        .await
        .unwrap();
    let draft = draft.expect("draft milestone inserts");
    assert_eq!(draft.kind, "draft");
    assert_eq!(draft.changed_blocks, 1);
    assert!(draft.added_words > 0);

    let versions: Vec<DocumentVersionMeta> = server
        .req(
            reqwest::Method::GET,
            &alice.token,
            &format!("/documents/{}/versions", doc.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(versions.len(), 3);
    let full: DocumentVersion = server
        .req(
            reqwest::Method::GET,
            &alice.token,
            &format!("/documents/{}/versions/{}", doc.id, named.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(full.doc_json, doc_json);

    let activity: Vec<DocumentActivity> = server
        .req(
            reqwest::Method::GET,
            &alice.token,
            &format!("/documents/{}/activity", doc.id),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(activity.iter().any(|item| item.kind == "draft_saved"));

    // Bad snapshot payloads are rejected.
    let res = server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/documents/{}/snapshot", doc.id),
            Some(json!({"doc_json": "not json"})),
        )
        .await;
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn document_ws_fanout() {
    let server = boot().await;
    let alice = server.register("alice").await;
    let bob = server.register("bob").await;
    let mallory = server.register("mallory").await;
    server.befriend(&alice, &bob).await;

    let doc = create_doc(&server, &alice.token, "Live").await;
    server
        .req(
            reqwest::Method::PUT,
            &alice.token,
            &format!("/documents/{}/shares", doc.id),
            Some(json!({"subject_kind": "user", "subject_id": bob.user.id.0, "access": "read"})),
        )
        .await;
    let room = format!("document:{}", doc.id);

    // Unshared users can't even subscribe.
    let mut mallory_ws = ws_connect(&server, &mallory.token, std::slice::from_ref(&room)).await;
    match next_frame(&mut mallory_ws).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "forbidden_room"),
        other => panic!("expected forbidden_room, got {other:?}"),
    }

    let mut bob_ws = ws_connect(&server, &bob.token, std::slice::from_ref(&room)).await;
    sync_subs(&mut bob_ws).await;

    // Alice's edit fans out to bob with its seq.
    let local = yrs::Doc::new();
    let update_b64 = B64.encode(text_update(&local, "hello"));
    server
        .req(
            reqwest::Method::POST,
            &alice.token,
            &format!("/documents/{}/updates", doc.id),
            Some(json!({"update_b64": update_b64})),
        )
        .await;
    let ev = wait_for_event(&mut bob_ws, "document.update").await;
    assert_eq!(ev["seq"].as_i64().unwrap(), 1);
    assert_eq!(ev["update_b64"].as_str().unwrap(), update_b64);
    assert_eq!(ev["author"].as_i64().unwrap(), alice.user.id.0);

    // Read-access bob may broadcast awareness; alice receives it.
    let mut alice_ws = ws_connect(&server, &alice.token, std::slice::from_ref(&room)).await;
    sync_subs(&mut alice_ws).await;
    let res = server
        .req(
            reqwest::Method::POST,
            &bob.token,
            &format!("/documents/{}/awareness", doc.id),
            Some(json!({"data_b64": B64.encode(b"cursor-state")})),
        )
        .await;
    assert_eq!(res.status(), 204);
    let ev = wait_for_event(&mut alice_ws, "document.awareness").await;
    assert_eq!(ev["author"].as_i64().unwrap(), bob.user.id.0);

    // Meta changes fan out too.
    server
        .req(
            reqwest::Method::PATCH,
            &alice.token,
            &format!("/documents/{}", doc.id),
            Some(json!({"format": "screenplay"})),
        )
        .await;
    let ev = wait_for_event(&mut bob_ws, "document.meta").await;
    assert_eq!(ev["format"], "screenplay");
}
