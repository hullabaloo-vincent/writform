//! Password hashing: PBKDF2-HMAC-SHA-512 in PHC string format.
//!
//! PBKDF2 is used (rather than Argon2id) because it is FIPS-approved
//! (SP 800-132). The scheme name is embedded in the stored hash, so an
//! `argon2id` opt-in can be added later with per-user migration on login.

use base64::engine::general_purpose::STANDARD_NO_PAD as B64;
use base64::Engine;
use hmac::Hmac;
use rand::RngCore;
use sha2::Sha512;
use subtle::ConstantTimeEq;

/// OWASP-recommended floor for PBKDF2-HMAC-SHA-512.
pub const PBKDF2_ITERATIONS: u32 = 210_000;
const SALT_LEN: usize = 16;
const HASH_LEN: usize = 64;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PasswordError {
    #[error("malformed password hash")]
    Malformed,
    #[error("unsupported password scheme {0:?}")]
    UnsupportedScheme(String),
}

/// Hash a password for storage. Output: `$pbkdf2-sha512$i=210000$<salt>$<hash>`.
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    hash_with_salt(password, &salt, PBKDF2_ITERATIONS)
}

/// Verify a password against a stored PHC string in constant time.
pub fn verify_password(password: &str, stored: &str) -> Result<bool, PasswordError> {
    let mut parts = stored
        .strip_prefix('$')
        .ok_or(PasswordError::Malformed)?
        .split('$');
    let scheme = parts.next().ok_or(PasswordError::Malformed)?;
    if scheme != "pbkdf2-sha512" {
        return Err(PasswordError::UnsupportedScheme(scheme.to_string()));
    }
    let iters: u32 = parts
        .next()
        .and_then(|p| p.strip_prefix("i="))
        .and_then(|i| i.parse().ok())
        .ok_or(PasswordError::Malformed)?;
    let salt = parts
        .next()
        .and_then(|s| B64.decode(s).ok())
        .ok_or(PasswordError::Malformed)?;
    let expected = parts
        .next()
        .and_then(|h| B64.decode(h).ok())
        .ok_or(PasswordError::Malformed)?;
    if parts.next().is_some() || expected.len() != HASH_LEN {
        return Err(PasswordError::Malformed);
    }

    let mut actual = [0u8; HASH_LEN];
    pbkdf2::pbkdf2::<Hmac<Sha512>>(password.as_bytes(), &salt, iters, &mut actual)
        .expect("HMAC accepts any key length");
    Ok(actual.ct_eq(&expected).into())
}

fn hash_with_salt(password: &str, salt: &[u8], iterations: u32) -> String {
    let mut out = [0u8; HASH_LEN];
    pbkdf2::pbkdf2::<Hmac<Sha512>>(password.as_bytes(), salt, iterations, &mut out)
        .expect("HMAC accepts any key length");
    format!(
        "$pbkdf2-sha512$i={}${}${}",
        iterations,
        B64.encode(salt),
        B64.encode(out)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let stored = hash_with_salt("hunter2", b"0123456789abcdef", 1_000);
        assert!(verify_password("hunter2", &stored).unwrap());
        assert!(!verify_password("hunter3", &stored).unwrap());
    }

    #[test]
    fn full_iteration_round_trip() {
        let stored = hash_password("correct horse battery staple");
        assert!(stored.starts_with("$pbkdf2-sha512$i=210000$"));
        assert!(verify_password("correct horse battery staple", &stored).unwrap());
    }

    #[test]
    fn rejects_malformed_and_unknown_schemes() {
        assert_eq!(
            verify_password("x", "garbage"),
            Err(PasswordError::Malformed)
        );
        assert_eq!(
            verify_password("x", "$argon2id$whatever"),
            Err(PasswordError::UnsupportedScheme("argon2id".into()))
        );
    }
}
