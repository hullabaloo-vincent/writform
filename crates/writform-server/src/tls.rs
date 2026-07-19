//! TLS + identity bootstrap.
//!
//! First boot generates and persists under the data dir:
//! - `identity.key` — ML-DSA-65 seed (the server's long-term PQ identity)
//! - `tls-cert.pem` / `tls-key.pem` — self-signed ECDSA P-256 cert for rustls
//!
//! The cert is bound to the identity by an ML-DSA signature over its SPKI,
//! served from `/api/v1/identity` (see docs/crypto.md).

use std::path::Path;

use anyhow::Context;
use axum_server::tls_rustls::RustlsConfig;
use writform_crypto::identity::ServerIdentityKey;

pub struct TlsIdentity {
    pub identity: ServerIdentityKey,
    /// DER of the cert's SubjectPublicKeyInfo (what clients pin).
    pub spki_der: Vec<u8>,
    /// ML-DSA cert-binding signature, precomputed at boot.
    pub cert_binding_sig: Vec<u8>,
    pub rustls_config: RustlsConfig,
}

pub async fn load_or_generate(data_dir: &Path) -> anyhow::Result<TlsIdentity> {
    let identity = load_or_generate_identity(data_dir).await?;
    let (cert_pem, key_pem) = load_or_generate_cert(data_dir).await?;

    let cert_der = pem_to_der(&cert_pem).context("parsing tls-cert.pem")?;
    let spki_der = extract_spki(&cert_der)?;
    let cert_binding_sig = identity.sign_cert_binding(&spki_der);

    let rustls_config = RustlsConfig::from_pem(cert_pem.into_bytes(), key_pem.into_bytes())
        .await
        .context("building rustls config")?;

    Ok(TlsIdentity {
        identity,
        spki_der,
        cert_binding_sig,
        rustls_config,
    })
}

async fn load_or_generate_identity(data_dir: &Path) -> anyhow::Result<ServerIdentityKey> {
    let path = data_dir.join("identity.key");
    if path.exists() {
        let bytes = tokio::fs::read(&path).await?;
        ServerIdentityKey::from_bytes(&bytes).with_context(|| format!("loading {}", path.display()))
    } else {
        let identity = ServerIdentityKey::generate();
        tokio::fs::write(&path, identity.to_bytes()).await?;
        restrict_permissions(&path).await?;
        tracing::info!(
            "generated new server identity, fingerprint {}",
            writform_crypto::identity::fingerprint(&identity.public_key_bytes())
        );
        Ok(identity)
    }
}

async fn load_or_generate_cert(data_dir: &Path) -> anyhow::Result<(String, String)> {
    let cert_path = data_dir.join("tls-cert.pem");
    let key_path = data_dir.join("tls-key.pem");
    if cert_path.exists() && key_path.exists() {
        Ok((
            tokio::fs::read_to_string(&cert_path).await?,
            tokio::fs::read_to_string(&key_path).await?,
        ))
    } else {
        // ECDSA P-256: rustls needs a classical cert; PQ authenticity comes
        // from the ML-DSA binding, PQ confidentiality from hybrid KEX.
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
        let mut params = rcgen::CertificateParams::new(vec!["writform".into()])?;
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "writform-server");
        let cert = params.self_signed(&key)?;

        let cert_pem = cert.pem();
        let key_pem = key.serialize_pem();
        tokio::fs::write(&cert_path, &cert_pem).await?;
        tokio::fs::write(&key_path, &key_pem).await?;
        restrict_permissions(&key_path).await?;
        tracing::info!("generated new self-signed TLS certificate");
        Ok((cert_pem, key_pem))
    }
}

fn pem_to_der(pem: &str) -> anyhow::Result<Vec<u8>> {
    let (_, doc) = x509_parser::pem::parse_x509_pem(pem.as_bytes())
        .map_err(|e| anyhow::anyhow!("bad PEM: {e}"))?;
    Ok(doc.contents)
}

/// Extract the raw SubjectPublicKeyInfo DER from a certificate.
pub fn extract_spki(cert_der: &[u8]) -> anyhow::Result<Vec<u8>> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der)
        .map_err(|e| anyhow::anyhow!("bad certificate DER: {e}"))?;
    Ok(cert.tbs_certificate.subject_pki.raw.to_vec())
}

#[cfg(unix)]
async fn restrict_permissions(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    tokio::fs::set_permissions(path, perms).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn restrict_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}
