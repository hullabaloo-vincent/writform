//! Cryptographic primitives for WritForm.
//!
//! Everything security-sensitive is concentrated here so it can be reviewed
//! (and swapped — e.g. RustCrypto → aws-lc-rs) in one place. See
//! `docs/crypto.md` for the protocol spec.
//!
//! FIPS posture: algorithm-compliant (FIPS 203/204 for KEX/signatures via the
//! transport layer and identity module, PBKDF2-HMAC-SHA-512 for passwords),
//! not a certified FIPS 140-3 module.

pub mod identity;
pub mod password;
pub mod token;
