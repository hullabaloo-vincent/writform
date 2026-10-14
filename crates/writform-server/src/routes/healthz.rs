use axum::extract::State;
use axum::Json;
use writform_proto::api::Healthz;

use crate::db::now_millis;
use crate::routes::AppState;

pub async fn healthz(State(state): State<AppState>) -> Json<Healthz> {
    let db_ok = sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();
    // (A server with no accounts yet takes the first, its admin, whatever it says.)
    let registration = if super::registration::has_users(&state.pool).await {
        super::registration::effective(&state).await
    } else {
        writform_proto::api::Registration::Open
    };
    Json(Healthz {
        ok: db_ok,
        server_name: state.server_name.to_string(),
        protocol_version: writform_proto::PROTOCOL_VERSION,
        server_time: now_millis(),
        registration: Some(registration),
    })
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use crate::routes::{router, AppState};

    #[tokio::test]
    async fn healthz_reports_ok() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let app = router(AppState::new("Test Server".into(), pool, b"pk", b"sig"));

        let res = app
            .oneshot(Request::get("/api/v1/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = http_body_util::BodyExt::collect(res.into_body())
            .await
            .unwrap()
            .to_bytes();
        let body: writform_proto::api::Healthz = serde_json::from_slice(&bytes).unwrap();
        assert!(body.ok);
        assert_eq!(body.server_name, "Test Server");
        assert_eq!(body.protocol_version, writform_proto::PROTOCOL_VERSION);
    }
}
