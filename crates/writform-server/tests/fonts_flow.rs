//! The font caching route against a stand-in catalog: a miss fetches and
//! keeps, a hit doesn't ask again, what isn't a font is refused and never
//! kept, and a server told not to fetch still serves what it has.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::json;
use writform_proto::api::AuthResponse;
use writform_server::routes::{self, fonts::FontCache};

/// A minimal "font": a TrueType header and some bytes.
const FONT: &[u8] = &[
    0x00, 0x01, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x80, 0, 3, 0, 0x40, 1, 2, 3, 4,
];

/// A stand-in for the catalog's CDN. Returns its base address and a count
/// of the requests it has answered.
async fn catalog() -> (String, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let app = axum::Router::new().route(
        "/{family}/{file}",
        axum::routing::get(
            move |axum::extract::Path((family, file)): axum::extract::Path<(String, String)>| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    match (family.as_str(), file.as_str()) {
                        ("inter@latest", "latin-400-normal.ttf") => (
                            axum::http::StatusCode::OK,
                            [(axum::http::header::CONTENT_TYPE, "font/ttf")],
                            FONT.to_vec(),
                        ),
                        // A captive portal, an error page: 200, but not a font.
                        ("portal@latest", _) => (
                            axum::http::StatusCode::OK,
                            [(axum::http::header::CONTENT_TYPE, "text/html")],
                            b"<!doctype html><title>Sign in to Wi-Fi</title>".to_vec(),
                        ),
                        _ => (
                            axum::http::StatusCode::NOT_FOUND,
                            [(axum::http::header::CONTENT_TYPE, "text/plain")],
                            b"no".to_vec(),
                        ),
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://127.0.0.1:{}", addr.port()), hits)
}

async fn boot(
    upstream: String,
    enabled: bool,
) -> (String, reqwest::Client, String, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap().keep();
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let mut state =
        routes::AppState::with_data_dir("Fonts Test".into(), pool, b"pk", b"sig", dir.clone());
    state.fonts = Arc::new(FontCache {
        dir: dir.join("fonts"),
        upstream,
        enabled: AtomicBool::new(enabled),
    });
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
    let base = format!("http://127.0.0.1:{}/api/v1", addr.port());
    let client = reqwest::Client::new();
    let auth: AuthResponse = client
        .post(format!("{base}/auth/register"))
        .json(&json!({"username": "alice", "password": "password-123"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (base, client, auth.token, dir)
}

async fn code(res: reqwest::Response) -> String {
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    body["code"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn a_font_is_fetched_once_and_kept() {
    let (upstream, hits) = catalog().await;
    let (base, client, token, dir) = boot(upstream, true).await;
    let url = format!("{base}/fonts/inter/latin-400-normal.ttf");

    // Signed-in people only: this is a group's server, not a public proxy.
    assert_eq!(client.get(&url).send().await.unwrap().status(), 401);
    assert_eq!(hits.load(Ordering::SeqCst), 0);

    // A miss asks the catalog, answers with the font, and keeps it.
    let res = client.get(&url).bearer_auth(&token).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "font/ttf");
    assert!(res.headers()["cache-control"]
        .to_str()
        .unwrap()
        .contains("immutable"));
    assert_eq!(res.bytes().await.unwrap().as_ref(), FONT);
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read(dir.join("fonts/inter/latin-400-normal.ttf")).unwrap(),
        FONT
    );

    // A hit is served from the server's own copy.
    let res = client.get(&url).bearer_auth(&token).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.bytes().await.unwrap().as_ref(), FONT);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "the catalog isn't asked twice"
    );
}

#[tokio::test]
async fn what_is_not_a_font_is_refused_and_never_kept() {
    let (upstream, hits) = catalog().await;
    let (base, client, token, dir) = boot(upstream, true).await;

    // The catalog answered 200 with a web page.
    let res = client
        .get(format!("{base}/fonts/portal/latin-400-normal.ttf"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 502);
    assert_eq!(code(res).await, "font_unavailable");
    assert!(!dir.join("fonts/portal/latin-400-normal.ttf").exists());

    // A file the catalog doesn't have.
    let res = client
        .get(format!("{base}/fonts/inter/latin-900-italic.ttf"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    assert_eq!(code(res).await, "no_such_font");

    // Names outside the grammar never reach the catalog at all.
    let before = hits.load(Ordering::SeqCst);
    for path in [
        "Inter/latin-400-normal.ttf",
        "inter/latin-400-normal.woff2",
        "inter/latin-450-normal.ttf",
        "inter/..%2F..%2Fsecret-400-normal.ttf",
        "in.ter/latin-400-normal.ttf",
    ] {
        let res = client
            .get(format!("{base}/fonts/{path}"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400, "{path}");
    }
    assert_eq!(hits.load(Ordering::SeqCst), before);
}

#[tokio::test]
async fn a_server_told_not_to_fetch_serves_only_what_it_has() {
    let (upstream, hits) = catalog().await;
    let (base, client, token, dir) = boot(upstream, false).await;
    let url = format!("{base}/fonts/inter/latin-400-normal.ttf");

    let res = client.get(&url).bearer_auth(&token).send().await.unwrap();
    assert_eq!(res.status(), 404);
    assert_eq!(code(res).await, "font_proxy_off");
    assert_eq!(hits.load(Ordering::SeqCst), 0);

    // A file already there (fetched before it was switched off, or put
    // there by the admin) is still served.
    std::fs::create_dir_all(dir.join("fonts/inter")).unwrap();
    std::fs::write(dir.join("fonts/inter/latin-400-normal.ttf"), FONT).unwrap();
    let res = client.get(&url).bearer_auth(&token).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.bytes().await.unwrap().as_ref(), FONT);
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}
