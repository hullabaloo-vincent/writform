//! Link-preview endpoint: fetches a page's title/OpenGraph metadata with
//! guardrails (auth required, http(s) only, graceful fallback).

use serde_json::json;
use writform_proto::api::{AuthResponse, LinkPreview};
use writform_server::routes;

async fn boot() -> (String, reqwest::Client) {
    let dir = tempfile::tempdir().unwrap();
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let state =
        routes::AppState::with_data_dir("Preview Test".into(), pool, b"pk", b"sig", dir.keep());
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

/// Serve one static HTML page on an ephemeral port.
async fn serve_page(html: &'static str) -> String {
    let app = axum::Router::new().route(
        "/page",
        axum::routing::get(move || async move {
            (
                [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
                html,
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://127.0.0.1:{}/page", addr.port())
}

#[tokio::test]
async fn preview_extracts_metadata() {
    let (base, client) = boot().await;
    let auth: AuthResponse = client
        .post(format!("{base}/auth/register"))
        .json(&json!({"username": "alice", "password": "password-123"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Unauthenticated → 401.
    let res = client
        .get(format!("{base}/link-preview?url=http://example.invalid"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);

    // Non-http scheme → 400.
    let res = client
        .get(format!("{base}/link-preview?url=file:///etc/passwd"))
        .bearer_auth(&auth.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);

    // Real page: og:title wins over <title>; og:image extracted.
    let page = serve_page(
        r#"<html><head>
            <title>Fallback Title</title>
            <meta property="og:title" content="A Great Essay &amp; More">
            <meta property="og:description" content="What it says">
            <meta property="og:image" content="https://example.com/cover.png">
        </head><body>hi</body></html>"#,
    )
    .await;
    let preview: LinkPreview = client
        .get(format!("{base}/link-preview?url={page}"))
        .bearer_auth(&auth.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(preview.title.as_deref(), Some("A Great Essay & More"));
    assert_eq!(preview.description.as_deref(), Some("What it says"));
    assert_eq!(
        preview.image_url.as_deref(),
        Some("https://example.com/cover.png")
    );

    // Unreachable host → graceful empty preview, not an error.
    let preview: LinkPreview = client
        .get(format!(
            "{base}/link-preview?url=http://127.0.0.1:1/nothing"
        ))
        .bearer_auth(&auth.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(preview.title.is_none());
}
