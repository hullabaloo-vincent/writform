//! Integration tests for register/login/logout over the axum router
//! (in-memory SQLite, no TLS — the TLS/pinning path is covered by
//! `tls_identity.rs`).

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;
use writform_proto::api::{ApiError, AuthResponse, User};

async fn test_app() -> axum::Router {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let state =
        writform_server::routes::AppState::new("Test".into(), pool, b"pubkey", b"binding-sig");
    writform_server::routes::router(state).layer(MockConnectInfo(std::net::SocketAddr::from((
        [127, 0, 0, 1],
        9999,
    ))))
}

async fn post_json(
    app: &axum::Router,
    path: &str,
    body: serde_json::Value,
) -> (StatusCode, Vec<u8>) {
    let res = app
        .clone()
        .oneshot(
            Request::post(path)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, bytes)
}

#[tokio::test]
async fn register_login_me_logout_round_trip() {
    let app = test_app().await;

    // Register
    let (status, body) = post_json(
        &app,
        "/api/v1/auth/register",
        json!({"username": "alice", "password": "hunter22222"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let reg: AuthResponse = serde_json::from_slice(&body).unwrap();
    assert_eq!(reg.user.username, "alice");

    // Duplicate username (case-insensitive) is a conflict
    let (status, body) = post_json(
        &app,
        "/api/v1/auth/register",
        json!({"username": "ALICE", "password": "hunter22222"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let err: ApiError = serde_json::from_slice(&body).unwrap();
    assert_eq!(err.code, "username_taken");

    // Login with wrong password fails
    let (status, body) = post_json(
        &app,
        "/api/v1/auth/login",
        json!({"username": "alice", "password": "wrong-password", "device_label": null}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let err: ApiError = serde_json::from_slice(&body).unwrap();
    assert_eq!(err.code, "invalid_credentials");

    // Unknown user gets the same error shape
    let (status, body) = post_json(
        &app,
        "/api/v1/auth/login",
        json!({"username": "nobody", "password": "whatever123", "device_label": null}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let err: ApiError = serde_json::from_slice(&body).unwrap();
    assert_eq!(err.code, "invalid_credentials");

    // Login works
    let (status, body) = post_json(
        &app,
        "/api/v1/auth/login",
        json!({"username": "alice", "password": "hunter22222", "device_label": "test rig"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let login: AuthResponse = serde_json::from_slice(&body).unwrap();

    // /me with the token
    let res = app
        .clone()
        .oneshot(
            Request::get("/api/v1/auth/me")
                .header(header::AUTHORIZATION, format!("Bearer {}", login.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let me: User = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(me.username, "alice");

    // Logout revokes the token
    let res = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/logout")
                .header(header::AUTHORIZATION, format!("Bearer {}", login.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let res = app
        .clone()
        .oneshot(
            Request::get("/api/v1/auth/me")
                .header(header::AUTHORIZATION, format!("Bearer {}", login.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn login_rate_limit_kicks_in() {
    let app = test_app().await;
    for _ in 0..10 {
        let (status, _) = post_json(
            &app,
            "/api/v1/auth/login",
            json!({"username": "ghost", "password": "whatever123", "device_label": null}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, body) = post_json(
        &app,
        "/api/v1/auth/login",
        json!({"username": "ghost", "password": "whatever123", "device_label": null}),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let err: ApiError = serde_json::from_slice(&body).unwrap();
    assert_eq!(err.code, "rate_limited");
}
