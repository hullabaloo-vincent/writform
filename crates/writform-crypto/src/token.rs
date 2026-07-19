//! Opaque bearer tokens. The DB stores only `SHA-256(token)`, so a leaked
//! database cannot be replayed as live sessions.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

const TOKEN_BYTES: usize = 32;

/// Generate a fresh session token (base64url, 43 chars).
pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    B64URL.encode(bytes)
}

/// Hash a token for storage/lookup (hex-encoded SHA-256).
pub fn token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        write!(out, "{b:02x}").unwrap();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_hash_deterministically() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert_eq!(token_hash(&a), token_hash(&a));
        assert_ne!(token_hash(&a), token_hash(&b));
    }
}
