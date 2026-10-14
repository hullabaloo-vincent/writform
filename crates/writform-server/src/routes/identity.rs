use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use writform_proto::api::{IdentityProof, IdentityProofRequest, ServerIdentity};

use crate::error::AppError;
use crate::routes::AppState;

/// Prove this server holds its identity key, over a nonce the client chose:
/// how a server reached through a proxy (whose certificate isn't its own)
/// shows it is the server the client trusted.
pub async fn proof(
    State(state): State<AppState>,
    Json(req): Json<IdentityProofRequest>,
) -> Result<Json<IdentityProof>, AppError> {
    let nonce = B64URL
        .decode(req.nonce.trim())
        .map_err(|_| AppError::bad_request("bad_nonce", "the nonce isn't base64url"))?;
    if nonce.len() < 16 || nonce.len() > 64 {
        return Err(AppError::bad_request(
            "bad_nonce",
            "the nonce must be 16 to 64 bytes",
        ));
    }
    let Some(key) = &state.identity else {
        return Err(AppError::new(
            StatusCode::NOT_IMPLEMENTED,
            "no_identity",
            "this server can't prove its identity",
        ));
    };
    Ok(Json(IdentityProof {
        sig: B64URL.encode(key.sign_identity_proof(&nonce)),
    }))
}

/// Unauthenticated server identity for TOFU pinning (see docs/crypto.md).
pub async fn identity(State(state): State<AppState>) -> Json<ServerIdentity> {
    Json(ServerIdentity {
        server_name: state.server_name.to_string(),
        mldsa_pubkey: state.identity_pubkey_b64.to_string(),
        cert_binding_sig: state.cert_binding_sig_b64.to_string(),
    })
}
