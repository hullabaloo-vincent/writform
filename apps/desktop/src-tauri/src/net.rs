//! Pinned-TLS HTTP client. All server traffic flows through here — the
//! webview cannot pin certificates, so it never talks to the network itself.
//!
//! Two verifier modes:
//! - **Capture**: accept any cert but record the leaf DER. Used only for the
//!   TOFU probe (`/healthz` + `/identity`, public data) — trust is decided
//!   *after* verifying the ML-DSA cert binding against what was captured.
//! - **Pinned**: reject any cert whose SPKI hash differs from the pin. Used
//!   for everything else (auth, API, attachments).
//! - **Public**: a server reached through a proxy (Cloudflare, a tunnel)
//!   shows the proxy's certificate, which can't be pinned: it must be valid
//!   for the host under the public roots, and the server proves its pinned
//!   identity over a fresh nonce before anything private is sent
//!   (commands/connect.rs `prove_identity`).

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum NetError {
    #[error("could not reach server: {0}")]
    Unreachable(String),
    #[error("server certificate does not match the pinned identity")]
    PinMismatch,
    #[error("malformed server response: {0}")]
    BadResponse(String),
}

/// Raw SubjectPublicKeyInfo DER of a certificate (what the ML-DSA binding
/// signature covers).
pub fn spki_der(cert_der: &[u8]) -> Result<Vec<u8>, NetError> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der)
        .map_err(|e| NetError::BadResponse(format!("bad certificate: {e}")))?;
    Ok(cert.tbs_certificate.subject_pki.raw.to_vec())
}

/// SHA-256 of a certificate's SubjectPublicKeyInfo DER.
pub fn spki_sha256(cert_der: &[u8]) -> Result<[u8; 32], NetError> {
    Ok(Sha256::digest(spki_der(cert_der)?).into())
}

#[derive(Debug)]
enum Mode {
    Capture(Mutex<Option<Vec<u8>>>),
    Pinned([u8; 32]),
    Public(Arc<rustls::client::WebPkiServerVerifier>),
}

/// How a saved server's connection is trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    /// Its own certificate, pinned by its SPKI hash.
    Pinned([u8; 32]),
    /// A public certificate (a proxy's), and its identity proved over a nonce.
    Public,
}

/// What `SavedServer.spki_hash` holds for a server trusted by `Trust::Public`.
pub const PUBLIC_PIN: &str = "public";

/// Random bytes from the TLS provider's own source.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    PinVerifier::provider()
        .secure_random
        .fill(&mut out)
        .expect("random bytes");
    out
}

#[derive(Debug)]
pub struct PinVerifier {
    mode: Mode,
    schemes: Vec<SignatureScheme>,
}

impl PinVerifier {
    fn provider() -> Arc<rustls::crypto::CryptoProvider> {
        if let Some(provider) = rustls::crypto::CryptoProvider::get_default() {
            return provider.clone();
        }
        // Normally installed in `run()`; this path covers tests.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        rustls::crypto::CryptoProvider::get_default()
            .expect("provider just installed")
            .clone()
    }

    pub fn capture() -> Arc<Self> {
        Arc::new(Self {
            mode: Mode::Capture(Mutex::new(None)),
            schemes: Self::provider()
                .signature_verification_algorithms
                .supported_schemes(),
        })
    }

    pub fn pinned(spki_hash: [u8; 32]) -> Arc<Self> {
        Arc::new(Self {
            mode: Mode::Pinned(spki_hash),
            schemes: Self::provider()
                .signature_verification_algorithms
                .supported_schemes(),
        })
    }

    /// A certificate the public roots vouch for, for the host connected to.
    pub fn public() -> Arc<Self> {
        let provider = Self::provider();
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let webpki = rustls::client::WebPkiServerVerifier::builder_with_provider(
            Arc::new(roots),
            provider.clone(),
        )
        .build()
        .expect("the public roots make a verifier");
        Arc::new(Self {
            mode: Mode::Public(webpki),
            schemes: provider
                .signature_verification_algorithms
                .supported_schemes(),
        })
    }

    pub fn for_trust(trust: Trust) -> Arc<Self> {
        match trust {
            Trust::Pinned(pin) => Self::pinned(pin),
            Trust::Public => Self::public(),
        }
    }

    /// The leaf cert DER captured during a probe handshake.
    pub fn captured_cert(&self) -> Option<Vec<u8>> {
        match &self.mode {
            Mode::Capture(slot) => slot.lock().expect("poisoned").clone(),
            Mode::Pinned(_) | Mode::Public(_) => None,
        }
    }
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match &self.mode {
            Mode::Public(webpki) => webpki.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            ),
            Mode::Capture(slot) => {
                *slot.lock().expect("poisoned") = Some(end_entity.as_ref().to_vec());
                Ok(ServerCertVerified::assertion())
            }
            Mode::Pinned(expected) => {
                let actual = spki_sha256(end_entity.as_ref()).map_err(|_| {
                    rustls::Error::InvalidCertificate(rustls::CertificateError::BadEncoding)
                })?;
                if &actual == expected {
                    Ok(ServerCertVerified::assertion())
                } else {
                    Err(rustls::Error::InvalidCertificate(
                        rustls::CertificateError::ApplicationVerificationFailure,
                    ))
                }
            }
        }
    }

    // The handshake signature is still cryptographically verified — pinning
    // replaces only the *chain trust* decision, not signature checks.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &Self::provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &Self::provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.schemes.clone()
    }
}

/// Build a reqwest client using the given verifier.
pub fn client_with_verifier(verifier: Arc<PinVerifier>) -> reqwest::Client {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("building http client")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Self-signed cert fixture for SPKI extraction tests.
    fn make_cert() -> Vec<u8> {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        rcgen::CertificateParams::new(vec!["writform".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap()
            .der()
            .to_vec()
    }

    #[test]
    fn spki_hash_is_stable_and_distinguishes_certs() {
        let cert_a = make_cert();
        let cert_b = make_cert();
        assert_eq!(spki_sha256(&cert_a).unwrap(), spki_sha256(&cert_a).unwrap());
        assert_ne!(spki_sha256(&cert_a).unwrap(), spki_sha256(&cert_b).unwrap());
    }

    #[test]
    fn pinned_verifier_accepts_match_and_rejects_mismatch() {
        let cert_a = make_cert();
        let cert_b = make_cert();
        let pin = spki_sha256(&cert_a).unwrap();
        let verifier = PinVerifier::pinned(pin);

        let name = ServerName::try_from("127.0.0.1").unwrap();
        let ok = verifier.verify_server_cert(
            &CertificateDer::from(cert_a.clone()),
            &[],
            &name,
            &[],
            UnixTime::now(),
        );
        assert!(ok.is_ok());

        let bad = verifier.verify_server_cert(
            &CertificateDer::from(cert_b),
            &[],
            &name,
            &[],
            UnixTime::now(),
        );
        assert!(bad.is_err());
    }

    #[test]
    fn capture_verifier_records_cert() {
        let cert = make_cert();
        let verifier = PinVerifier::capture();
        let name = ServerName::try_from("127.0.0.1").unwrap();
        verifier
            .verify_server_cert(
                &CertificateDer::from(cert.clone()),
                &[],
                &name,
                &[],
                UnixTime::now(),
            )
            .unwrap();
        assert_eq!(verifier.captured_cert().unwrap(), cert);
    }
}
