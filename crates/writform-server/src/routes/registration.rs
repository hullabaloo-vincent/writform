//! Who may make an account here: anyone, only someone with an invite code
//! from a server admin, or no one. Fixed by `WRITFORM_REGISTRATION`, or
//! chosen by a server admin in the app (network.rs).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use rand::Rng;
use sqlx::{SqliteConnection, SqlitePool};
use writform_proto::api::{
    CreateServerInviteRequest, Registration, RegistrationSettings, ServerInvite,
};

use crate::auth::AuthUser;
use crate::db::now_millis;
use crate::error::AppError;
use crate::routes::admin::require_server_admin;
use crate::routes::AppState;

const SETTING: &str = "registration";

/// Whether the server has any account yet.
pub async fn has_users(pool: &SqlitePool) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM users)")
        .fetch_one(pool)
        .await
        .map(|n| n != 0)
        .unwrap_or(true)
}

/// Who may make an account now.
pub async fn effective(state: &AppState) -> Registration {
    if let Some(fixed) = state.network.registration {
        return fixed;
    }
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM server_settings WHERE key = ?")
            .bind(SETTING)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    stored
        .as_deref()
        .and_then(Registration::parse)
        .unwrap_or(Registration::Open)
}

/// Inside the transaction that makes the account: may it be made? A server
/// with no account yet takes the first (its admin) whatever it says. An
/// invite is used up by the account it makes.
pub async fn admit(
    state: &AppState,
    conn: &mut SqliteConnection,
    first: bool,
    invite: Option<&str>,
) -> Result<(), AppError> {
    if first {
        return Ok(());
    }
    match effective(state).await {
        Registration::Open => Ok(()),
        Registration::Closed => Err(AppError::new(
            StatusCode::FORBIDDEN,
            "registration_closed",
            "this server isn't taking new accounts",
        )),
        Registration::Invite => {
            let code = invite
                .map(|c| c.trim().to_ascii_uppercase())
                .unwrap_or_default();
            if code.is_empty() {
                return Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "invite_required",
                    "this server needs an invite code to make an account",
                ));
            }
            type Row = (i64, Option<i64>, Option<i64>, i64, bool);
            let row: Option<Row> = sqlx::query_as("SELECT id, expires_at, max_uses, use_count, revoked FROM server_invites WHERE code = ?").bind(&code).fetch_optional(&mut *conn).await?;
            let now = now_millis();
            let usable = |(_, expires, max, used, revoked): &Row| {
                !revoked && expires.is_none_or(|e| e > now) && max.is_none_or(|m| *used < m)
            };
            match row {
                Some(r) if usable(&r) => {
                    sqlx::query("UPDATE server_invites SET use_count = use_count + 1 WHERE id = ?")
                        .bind(r.0)
                        .execute(&mut *conn)
                        .await?;
                    Ok(())
                }
                _ => Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "invalid_invite",
                    "that invite code isn't valid here",
                )),
            }
        }
    }
}

pub async fn get_registration(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<RegistrationSettings>, AppError> {
    require_server_admin(&state, &auth).await?;
    Ok(Json(RegistrationSettings {
        mode: effective(&state).await,
        fixed: state.network.registration.is_some(),
    }))
}

pub async fn set_registration(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<RegistrationSettings>,
) -> Result<Json<RegistrationSettings>, AppError> {
    require_server_admin(&state, &auth).await?;
    if state.network.registration.is_some() {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "registration_fixed",
            "this server's configuration sets who may make an account",
        ));
    }
    sqlx::query("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(SETTING)
        .bind(req.mode.as_str())
        .execute(&state.pool)
        .await?;
    Ok(Json(RegistrationSettings {
        mode: req.mode,
        fixed: false,
    }))
}

type InviteRow = (
    i64,
    String,
    String,
    i64,
    Option<i64>,
    Option<i64>,
    i64,
    bool,
);
const INVITE_SELECT: &str = "SELECT i.id, i.code, u.username, i.created_at, i.expires_at, i.max_uses, i.use_count, i.revoked
    FROM server_invites i JOIN users u ON u.id = i.created_by";

fn invite_of(
    (id, code, created_by, created_at, expires_at, max_uses, use_count, revoked): InviteRow,
) -> ServerInvite {
    let now = now_millis();
    let spent =
        revoked || expires_at.is_some_and(|e| e <= now) || max_uses.is_some_and(|m| use_count >= m);
    ServerInvite {
        id,
        code,
        created_by,
        created_at,
        expires_at,
        max_uses,
        use_count,
        spent,
    }
}

pub async fn list_invites(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<ServerInvite>>, AppError> {
    require_server_admin(&state, &auth).await?;
    let rows: Vec<InviteRow> = sqlx::query_as(&format!(
        "{INVITE_SELECT} ORDER BY i.created_at DESC LIMIT 200"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(invite_of).collect()))
}

/// A code that reads aloud well: no 0 and O, 1 and I.
fn new_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..10)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

pub async fn create_invite(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<CreateServerInviteRequest>,
) -> Result<Json<ServerInvite>, AppError> {
    require_server_admin(&state, &auth).await?;
    let max_uses = req.max_uses.filter(|n| *n > 0).map(|n| n.min(10_000));
    let now = now_millis();
    let expires_at = req
        .expires_in_hours
        .filter(|h| *h > 0)
        .map(|h| now + h.min(24 * 365) * 3_600_000);
    let id: i64 = sqlx::query_scalar("INSERT INTO server_invites (code, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .bind(new_code())
        .bind(auth.user_id.0)
        .bind(now)
        .bind(expires_at)
        .bind(max_uses)
        .fetch_one(&state.pool)
        .await?;
    let row: InviteRow = sqlx::query_as(&format!("{INVITE_SELECT} WHERE i.id = ?"))
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(invite_of(row)))
}

pub async fn revoke_invite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    require_server_admin(&state, &auth).await?;
    sqlx::query("UPDATE server_invites SET revoked = 1 WHERE id = ?")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
