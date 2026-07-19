use axum::extract::State;
use axum::Json;
use writform_proto::api::ServerIdentity;

use crate::routes::AppState;

/// Unauthenticated server identity for TOFU pinning (see docs/crypto.md).
pub async fn identity(State(state): State<AppState>) -> Json<ServerIdentity> {
    Json(ServerIdentity {
        server_name: state.server_name.to_string(),
        mldsa_pubkey: state.identity_pubkey_b64.to_string(),
        cert_binding_sig: state.cert_binding_sig_b64.to_string(),
    })
}
