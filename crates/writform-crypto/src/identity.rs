//! Server identity: ML-DSA-65 (FIPS 204) keypair whose signature binds the
//! server's self-signed TLS certificate to a pinnable post-quantum identity.
//!
//! The TLS cert is classical (ECDSA P-256, rustls requirement); authenticity
//! against a quantum adversary comes from this binding: clients pin the
//! ML-DSA public key on first use and verify a domain-separated signature
//! over `SHA-256(cert SPKI)` on every connect.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use ml_dsa::{EncodedVerifyingKey, MlDsa65, Seed, Signature, SigningKey, VerifyingKey};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// ML-DSA context string — domain-separates cert-binding signatures from any
/// other use of the identity key.
const BINDING_CTX: &[u8] = b"writform-cert-binding-v1";

/// Context for a proof of identity over a client's nonce: what a server
/// reached through a proxy (whose certificate isn't its own) shows instead
/// of the binding.
const PROOF_CTX: &[u8] = b"writform-identity-proof-v1";

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("malformed identity key material")]
    MalformedKey,
    #[error("malformed signature")]
    MalformedSignature,
}

/// The server's long-term identity keypair, stored as its 32-byte seed.
pub struct ServerIdentityKey {
    seed: [u8; 32],
    signing_key: SigningKey<MlDsa65>,
}

impl ServerIdentityKey {
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut seed);
        Self::from_seed(seed)
    }

    fn from_seed(seed: [u8; 32]) -> Self {
        let signing_key = SigningKey::<MlDsa65>::from_seed(&Seed::from(seed));
        Self { seed, signing_key }
    }

    /// Serialize for storage in `data/identity.key` (the raw seed).
    pub fn to_bytes(&self) -> Vec<u8> {
        self.seed.to_vec()
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, IdentityError> {
        let seed: [u8; 32] = bytes.try_into().map_err(|_| IdentityError::MalformedKey)?;
        Ok(Self::from_seed(seed))
    }

    /// Public key bytes (what clients pin, and what `/identity` serves).
    pub fn public_key_bytes(&self) -> Vec<u8> {
        self.signing_key
            .expanded_key()
            .verifying_key()
            .encode()
            .to_vec()
    }

    pub fn public_key_b64(&self) -> String {
        B64URL.encode(self.public_key_bytes())
    }

    /// Sign the binding between this identity and a TLS cert's SPKI (DER).
    pub fn sign_cert_binding(&self, spki_der: &[u8]) -> Vec<u8> {
        let sig = self
            .signing_key
            .expanded_key()
            .sign_deterministic(&Sha256::digest(spki_der), BINDING_CTX)
            .expect("context is under 255 bytes");
        sig.encode().to_vec()
    }

    /// Prove this identity to a client: a signature over its nonce.
    pub fn sign_identity_proof(&self, nonce: &[u8]) -> Vec<u8> {
        let sig = self
            .signing_key
            .expanded_key()
            .sign_deterministic(&Sha256::digest(nonce), PROOF_CTX)
            .expect("context is under 255 bytes");
        sig.encode().to_vec()
    }
}

/// Verify a proof of identity over a nonce the client chose.
pub fn verify_identity_proof(
    public_key: &[u8],
    nonce: &[u8],
    signature: &[u8],
) -> Result<bool, IdentityError> {
    let encoded = EncodedVerifyingKey::<MlDsa65>::try_from(public_key)
        .map_err(|_| IdentityError::MalformedKey)?;
    let key = VerifyingKey::<MlDsa65>::decode(&encoded);
    let sig =
        Signature::<MlDsa65>::try_from(signature).map_err(|_| IdentityError::MalformedSignature)?;
    Ok(key.verify_with_context(&Sha256::digest(nonce), PROOF_CTX, &sig))
}

/// Verify a cert-binding signature. Used by clients during TOFU and on every
/// reconnect.
pub fn verify_cert_binding(
    public_key: &[u8],
    spki_der: &[u8],
    signature: &[u8],
) -> Result<bool, IdentityError> {
    let encoded = EncodedVerifyingKey::<MlDsa65>::try_from(public_key)
        .map_err(|_| IdentityError::MalformedKey)?;
    let key = VerifyingKey::<MlDsa65>::decode(&encoded);
    let sig =
        Signature::<MlDsa65>::try_from(signature).map_err(|_| IdentityError::MalformedSignature)?;
    Ok(key.verify_with_context(&Sha256::digest(spki_der), BINDING_CTX, &sig))
}

/// Short human-checkable fingerprint of a public key, shown in the TOFU
/// prompt: `SHA-256(pubkey)` rendered as four hex groups, e.g. `3f2a-91cc-04b7-e812`.
pub fn fingerprint(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    digest[..8]
        .chunks(2)
        .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_proof_round_trip_and_separation() {
        let key = ServerIdentityKey::generate();
        let pk = key.public_key_bytes();
        let nonce = [7u8; 32];
        let sig = key.sign_identity_proof(&nonce);
        assert!(verify_identity_proof(&pk, &nonce, &sig).unwrap());
        // Another nonce, another key, or a binding signature is no proof.
        assert!(!verify_identity_proof(&pk, &[8u8; 32], &sig).unwrap());
        let other = ServerIdentityKey::generate();
        assert!(!verify_identity_proof(&other.public_key_bytes(), &nonce, &sig).unwrap());
        let binding = key.sign_cert_binding(&nonce);
        assert!(!verify_identity_proof(&pk, &nonce, &binding).unwrap());
        assert!(!verify_cert_binding(&pk, &nonce, &sig).unwrap());
    }

    #[test]
    fn binding_round_trip_and_tamper_cases() {
        let key = ServerIdentityKey::generate();
        let spki = b"fake-spki-der-bytes";
        let sig = key.sign_cert_binding(spki);

        assert!(verify_cert_binding(&key.public_key_bytes(), spki, &sig).unwrap());
        // Wrong SPKI
        assert!(!verify_cert_binding(&key.public_key_bytes(), b"other-spki", &sig).unwrap());
        // Wrong key
        let other = ServerIdentityKey::generate();
        assert!(!verify_cert_binding(&other.public_key_bytes(), spki, &sig).unwrap());
        // Corrupted signature
        let mut bad = sig.clone();
        bad[0] ^= 0xff;
        assert!(!verify_cert_binding(&key.public_key_bytes(), spki, &bad).unwrap());
        // Truncated signature is malformed, not just invalid
        assert!(verify_cert_binding(&key.public_key_bytes(), spki, &sig[..10]).is_err());
    }

    #[test]
    fn key_storage_round_trip() {
        let key = ServerIdentityKey::generate();
        let restored = ServerIdentityKey::from_bytes(&key.to_bytes()).unwrap();
        assert_eq!(key.public_key_bytes(), restored.public_key_bytes());

        let spki = b"spki";
        let sig = restored.sign_cert_binding(spki);
        assert!(verify_cert_binding(&key.public_key_bytes(), spki, &sig).unwrap());
    }

    #[test]
    fn fingerprint_is_stable_and_short() {
        let key = ServerIdentityKey::generate();
        let fp = fingerprint(&key.public_key_bytes());
        assert_eq!(fp, fingerprint(&key.public_key_bytes()));
        assert_eq!(fp.len(), 19); // 4 groups of 4 hex + 3 dashes
    }
}
