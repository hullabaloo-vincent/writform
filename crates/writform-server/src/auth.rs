//! Bearer-token authentication and login rate limiting.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use writform_proto::UserId;

use crate::db::now_millis;
use crate::error::AppError;
use crate::routes::AppState;

/// Sliding session lifetime: 30 days, refreshed on use.
pub const SESSION_LIFETIME_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Authenticated user, extracted from `Authorization: Bearer <token>`.
pub struct AuthUser {
    pub user_id: UserId,
    /// Hash of the presenting token (used by logout to revoke itself).
    pub token_hash: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let bearer = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_owned);
        let token = match bearer {
            Some(t) => t,
            None => {
                // The web client's <img>/<audio> loads can't carry headers;
                // it sets a `wf_token` cookie instead. Honored ONLY for
                // attachment GETs — read-only, so a cross-site request could
                // not mutate anything even without the SameSite guard.
                let cookie_ok = parts.method == axum::http::Method::GET
                    && parts.uri.path().starts_with("/api/v1/attachments/");
                cookie_ok
                    .then(|| {
                        parts
                            .headers
                            .get(axum::http::header::COOKIE)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|c| {
                                c.split(';').find_map(|kv| {
                                    kv.trim().strip_prefix("wf_token=").map(str::to_owned)
                                })
                            })
                    })
                    .flatten()
                    .ok_or_else(|| {
                        AppError::unauthorized("missing_token", "missing bearer token")
                    })?
            }
        };

        let token_hash = writform_crypto::token::token_hash(&token);
        let now = now_millis();
        let row: Option<(i64, i64)> =
            sqlx::query_as("SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?")
                .bind(&token_hash)
                .fetch_optional(&state.pool)
                .await?;

        let Some((user_id, expires_at)) = row else {
            return Err(AppError::unauthorized("invalid_token", "unknown token"));
        };
        if expires_at < now {
            sqlx::query("DELETE FROM auth_sessions WHERE token_hash = ?")
                .bind(&token_hash)
                .execute(&state.pool)
                .await?;
            return Err(AppError::unauthorized("expired_token", "session expired"));
        }

        // Sliding expiry; last_seen doubles as the device list's activity stamp.
        sqlx::query(
            "UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
        )
        .bind(now)
        .bind(now + SESSION_LIFETIME_MS)
        .bind(&token_hash)
        .execute(&state.pool)
        .await?;

        Ok(AuthUser {
            user_id: UserId(user_id),
            token_hash,
        })
    }
}

/// In-memory fixed-window login rate limiter, keyed by (ip, username).
pub struct LoginRateLimiter {
    window: Duration,
    max_attempts: usize,
    attempts: Mutex<HashMap<(IpAddr, String), Vec<Instant>>>,
}

impl Default for LoginRateLimiter {
    fn default() -> Self {
        Self {
            window: Duration::from_secs(60),
            max_attempts: 10,
            attempts: Mutex::new(HashMap::new()),
        }
    }
}

impl LoginRateLimiter {
    /// Record an attempt; returns false when over the limit.
    pub fn check(&self, ip: IpAddr, username: &str) -> bool {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().expect("rate limiter poisoned");
        // Drop stale windows opportunistically so the map can't grow unbounded.
        if attempts.len() > 10_000 {
            attempts.retain(|_, v| v.iter().any(|t| now.duration_since(*t) < self.window));
        }
        let entry = attempts.entry((ip, username.to_string())).or_default();
        entry.retain(|t| now.duration_since(*t) < self.window);
        if entry.len() >= self.max_attempts {
            return false;
        }
        entry.push(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_blocks_after_max() {
        let limiter = LoginRateLimiter::default();
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        for _ in 0..10 {
            assert!(limiter.check(ip, "alice"));
        }
        assert!(!limiter.check(ip, "alice"));
        // Different user or IP is unaffected.
        assert!(limiter.check(ip, "bob"));
        assert!(limiter.check("10.0.0.1".parse().unwrap(), "alice"));
    }
}
