use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use writform_proto::api::ApiError;

/// Uniform error type for all handlers: stable machine code + message,
/// serialized as `ApiError` on the wire.
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn unauthorized(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code, message)
    }

    pub fn internal(err: impl std::fmt::Display) -> Self {
        tracing::error!("internal error: {err}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiError {
                code: self.code.to_string(),
                message: self.message,
            }),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        Self::internal(err)
    }
}
