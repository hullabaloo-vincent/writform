//! Who may make an account (open, with an invite, no one), a server's proof
//! of its identity through a proxy, client addresses behind a proxy, and
//! link previews switched off.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{header, Request, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;
use writform_proto::api::{
    ApiError, AuthResponse, Healthz, IdentityProof, Registration, RegistrationSettings,
    ServerInvite,
};
use writform_server::network::{NetworkOptions, TrustProxy};
use writform_server::routes::AppState;

async fn state_with(network: NetworkOptions) -> AppState {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let mut state = AppState::new("Test".into(), pool, b"pubkey", b"binding-sig");
    state.network = Arc::new(network);
    state
}

fn app(state: AppState) -> axum::Router {
    writform_server::routes::router(state).layer(MockConnectInfo(std::net::SocketAddr::from((
        [127, 0, 0, 1],
        9999,
    ))))
}

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
    extra: &[(&str, &str)],
) -> (StatusCode, Vec<u8>) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let req = match body {
        Some(b) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(b.to_string()))
            .unwrap(),
        None => req.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    (
        status,
        res.into_body().collect().await.unwrap().to_bytes().to_vec(),
    )
}

async fn register(app: &axum::Router, name: &str, invite: Option<&str>) -> (StatusCode, Vec<u8>) {
    let mut body = json!({"username": name, "password": "a-long-password"});
    if let Some(code) = invite {
        body["invite"] = json!(code);
    }
    call(app, "POST", "/api/v1/auth/register", None, Some(body), &[]).await
}

fn code_of(body: &[u8]) -> String {
    serde_json::from_slice::<ApiError>(body)
        .map(|e| e.code)
        .unwrap_or_default()
}

async fn registration(app: &axum::Router) -> Option<Registration> {
    let (_, body) = call(app, "GET", "/api/v1/healthz", None, None, &[]).await;
    serde_json::from_slice::<Healthz>(&body)
        .unwrap()
        .registration
}

#[tokio::test]
async fn closed_by_configuration_still_takes_the_first_account() {
    let app = app(state_with(NetworkOptions {
        registration: Some(Registration::Closed),
        ..Default::default()
    })
    .await);
    assert_eq!(
        registration(&app).await,
        Some(Registration::Open),
        "an empty server takes its admin"
    );
    let (status, body) = register(&app, "admin", None).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let admin: AuthResponse = serde_json::from_slice(&body).unwrap();
    assert!(admin.user.is_server_admin);

    assert_eq!(registration(&app).await, Some(Registration::Closed));
    let (status, body) = register(&app, "stranger", None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code_of(&body), "registration_closed");

    // Fixed by the configuration: the app can't change it.
    let (status, body) = call(
        &app,
        "GET",
        "/api/v1/admin/registration",
        Some(&admin.token),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let now: RegistrationSettings = serde_json::from_slice(&body).unwrap();
    assert!(now.fixed && now.mode == Registration::Closed);
    let (status, body) = call(
        &app,
        "PUT",
        "/api/v1/admin/registration",
        Some(&admin.token),
        Some(json!({"mode": "open"})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code_of(&body), "registration_fixed");
}

#[tokio::test]
async fn an_admin_lets_people_in_with_invites() {
    let app = app(state_with(NetworkOptions::default()).await);
    let (_, body) = register(&app, "admin", None).await;
    let admin: AuthResponse = serde_json::from_slice(&body).unwrap();
    let (_, body) = register(&app, "member", None).await;
    let member: AuthResponse = serde_json::from_slice(&body).unwrap();
    assert!(!member.user.is_server_admin);
    assert_eq!(registration(&app).await, Some(Registration::Open));

    // Only an admin chooses.
    let (status, _) = call(
        &app,
        "PUT",
        "/api/v1/admin/registration",
        Some(&member.token),
        Some(json!({"mode": "closed"})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(
        &app,
        "PUT",
        "/api/v1/admin/registration",
        Some(&admin.token),
        Some(json!({"mode": "invite"})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(registration(&app).await, Some(Registration::Invite));

    let (status, body) = register(&app, "nocode", None).await;
    assert_eq!(
        (status, code_of(&body).as_str()),
        (StatusCode::FORBIDDEN, "invite_required")
    );
    let (status, body) = register(&app, "badcode", Some("NOPE")).await;
    assert_eq!(
        (status, code_of(&body).as_str()),
        (StatusCode::FORBIDDEN, "invalid_invite")
    );

    let (status, body) = call(
        &app,
        "POST",
        "/api/v1/admin/invites",
        Some(&admin.token),
        Some(json!({"max_uses": 1})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let invite: ServerInvite = serde_json::from_slice(&body).unwrap();
    assert_eq!(invite.code.len(), 10);
    assert!(!invite.spent && invite.use_count == 0 && invite.created_by == "admin");

    // Typed in small letters, it still counts.
    let (status, body) = register(&app, "invited", Some(&invite.code.to_lowercase())).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let (status, body) = register(&app, "second", Some(&invite.code)).await;
    assert_eq!(
        (status, code_of(&body).as_str()),
        (StatusCode::FORBIDDEN, "invalid_invite"),
        "used up"
    );

    let (_, body) = call(
        &app,
        "GET",
        "/api/v1/admin/invites",
        Some(&admin.token),
        None,
        &[],
    )
    .await;
    let list: Vec<ServerInvite> = serde_json::from_slice(&body).unwrap();
    assert!(list[0].use_count == 1 && list[0].spent);

    // A refused account leaves nothing behind (the name is still free).
    let (_, body) = call(
        &app,
        "POST",
        "/api/v1/admin/invites",
        Some(&admin.token),
        Some(json!({})),
        &[],
    )
    .await;
    let open: ServerInvite = serde_json::from_slice(&body).unwrap();
    let (status, _) = register(&app, "second", Some(&open.code)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/api/v1/admin/invites/{}", open.id),
        Some(&admin.token),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = register(&app, "third", Some(&open.code)).await;
    assert_eq!(
        (status, code_of(&body).as_str()),
        (StatusCode::FORBIDDEN, "invalid_invite"),
        "revoked"
    );

    let (status, _) = call(
        &app,
        "GET",
        "/api/v1/admin/invites",
        Some(&member.token),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn new_accounts_are_limited_by_address_and_a_proxy_says_whose() {
    let app = app(state_with(NetworkOptions {
        trust_proxy: TrustProxy::Cloudflare,
        ..Default::default()
    })
    .await);
    for i in 0..10 {
        let (status, body) = call(
            &app,
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({"username": format!("user{i}"), "password": "a-long-password"})),
            &[("cf-connecting-ip", "203.0.113.1")],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    }
    let (status, body) = call(
        &app,
        "POST",
        "/api/v1/auth/register",
        None,
        Some(json!({"username": "user10", "password": "a-long-password"})),
        &[("cf-connecting-ip", "203.0.113.1")],
    )
    .await;
    assert_eq!(
        (status, code_of(&body).as_str()),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    // Someone else, through the same proxy.
    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/auth/register",
        None,
        Some(json!({"username": "user11", "password": "a-long-password"})),
        &[("cf-connecting-ip", "203.0.113.2")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_server_proves_its_identity_over_a_nonce() {
    let mut state = state_with(NetworkOptions::default()).await;
    let key = writform_crypto::identity::ServerIdentityKey::generate();
    let pk = key.public_key_bytes();
    state.identity = Some(Arc::new(key));
    let app = app(state);
    let nonce = [9u8; 32];
    let (status, body) = call(
        &app,
        "POST",
        "/api/v1/identity/proof",
        None,
        Some(json!({"nonce": B64URL.encode(nonce)})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let proof: IdentityProof = serde_json::from_slice(&body).unwrap();
    let sig = B64URL.decode(proof.sig).unwrap();
    assert!(writform_crypto::identity::verify_identity_proof(&pk, &nonce, &sig).unwrap());
    assert!(!writform_crypto::identity::verify_identity_proof(&pk, &[1u8; 32], &sig).unwrap());
    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/identity/proof",
        None,
        Some(json!({"nonce": "short"})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A server that holds no key says so.
    let bare = self::app(state_with(NetworkOptions::default()).await);
    let (status, _) = call(
        &bare,
        "POST",
        "/api/v1/identity/proof",
        None,
        Some(json!({"nonce": B64URL.encode(nonce)})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
}

#[tokio::test]
async fn link_previews_can_be_switched_off() {
    let app = app(state_with(NetworkOptions {
        link_previews_off: true,
        ..Default::default()
    })
    .await);
    let (_, body) = register(&app, "admin", None).await;
    let admin: AuthResponse = serde_json::from_slice(&body).unwrap();
    let (status, body) = call(
        &app,
        "GET",
        "/api/v1/link-preview?url=https%3A%2F%2Fexample.com",
        Some(&admin.token),
        None,
        &[],
    )
    .await;
    assert_eq!(
        (status, code_of(&body).as_str()),
        (StatusCode::NOT_FOUND, "previews_off")
    );
}

#[test]
fn the_configuration_is_read_strictly() {
    use clap::Parser;
    let parse = |args: &[&str]| {
        writform_server::config::Config::try_parse_from([&["writform-server"], args].concat())
            .unwrap()
            .network()
    };
    let n = parse(&[
        "--registration",
        "invite",
        "--tls",
        "off",
        "--trust-proxy",
        "cloudflare",
        "--link-previews",
        "off",
    ])
    .unwrap();
    assert_eq!(n.registration, Some(Registration::Invite));
    assert!(n.plain_http && n.link_previews_off && n.trust_proxy == TrustProxy::Cloudflare);
    let d = parse(&[]).unwrap();
    assert!(
        d.registration.is_none()
            && !d.plain_http
            && !d.link_previews_off
            && d.trust_proxy == TrustProxy::None
    );
    assert!(parse(&["--registration", "sometimes"]).is_err());
    assert!(parse(&["--tls", "maybe"]).is_err());
}
