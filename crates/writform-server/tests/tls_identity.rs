//! Boots the real server with TLS in a temp dir and verifies the TOFU
//! material end to end: the served identity's binding signature must verify
//! against the SPKI of the certificate actually presented on the wire.

use std::net::SocketAddr;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use writform_proto::api::ServerIdentity;
use writform_server::{db, routes, tls};

async fn boot(data_dir: &std::path::Path) -> (SocketAddr, tls::TlsIdentity) {
    let tls_identity = tls::load_or_generate(data_dir).await.unwrap();
    let pool = db::connect(data_dir).await.unwrap();
    let state = routes::AppState::new(
        "TLS Test".into(),
        pool,
        &tls_identity.identity.public_key_bytes(),
        &tls_identity.cert_binding_sig,
    );
    let app = routes::router(state);

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let rustls_config = tls_identity.rustls_config.clone();
    tokio::spawn(async move {
        axum_server::from_tcp_rustls(listener, rustls_config)
            .unwrap()
            .serve(app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    (addr, tls_identity)
}

#[tokio::test]
async fn identity_binding_verifies_against_presented_cert() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let (addr, tls_identity) = boot(dir.path()).await;

    // Client that tolerates the self-signed cert (the desktop client pins
    // instead; this test verifies the binding material itself).
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap();

    let identity: ServerIdentity = client
        .get(format!("https://127.0.0.1:{}/api/v1/identity", addr.port()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(identity.server_name, "TLS Test");

    let pubkey = B64URL.decode(&identity.mldsa_pubkey).unwrap();
    let sig = B64URL.decode(&identity.cert_binding_sig).unwrap();

    // The SPKI of the cert on disk is what the server presents on the wire.
    let cert_pem = std::fs::read_to_string(dir.path().join("tls-cert.pem")).unwrap();
    let (_, der) = x509_parser::pem::parse_x509_pem(cert_pem.as_bytes()).unwrap();
    let spki = tls::extract_spki(&der.contents).unwrap();
    assert_eq!(spki, tls_identity.spki_der);

    assert!(writform_crypto::identity::verify_cert_binding(&pubkey, &spki, &sig).unwrap());

    // Tamper check: the binding must NOT verify for a different cert's SPKI.
    let other_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let other_cert = rcgen::CertificateParams::new(vec!["writform".into()])
        .unwrap()
        .self_signed(&other_key)
        .unwrap();
    let other_spki = tls::extract_spki(other_cert.der()).unwrap();
    assert!(!writform_crypto::identity::verify_cert_binding(&pubkey, &other_spki, &sig).unwrap());
}

#[tokio::test]
async fn identity_key_and_cert_persist_across_boots() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();

    let first = tls::load_or_generate(dir.path()).await.unwrap();
    let second = tls::load_or_generate(dir.path()).await.unwrap();
    assert_eq!(
        first.identity.public_key_bytes(),
        second.identity.public_key_bytes()
    );
    assert_eq!(first.spki_der, second.spki_der);
}
