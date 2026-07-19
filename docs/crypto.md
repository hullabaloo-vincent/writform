# WritForm crypto spec

Status: **draft** — this document is written ahead of the Phase 1 implementation
and is the source of truth for `crates/writform-crypto` and the client's pinning
logic. Change the doc first, then the code.

## Goals & posture

- Post-quantum confidentiality and authenticity using **FIPS-standardized
  algorithms**: ML-KEM-768 (FIPS 203) for key establishment, ML-DSA-65
  (FIPS 204) for the server identity, PBKDF2-HMAC-SHA-512 (SP 800-132) for
  passwords.
- *Algorithm*-compliant, not a certified FIPS 140-3 module.
- Never design a custom secure channel: all framing/AEAD/downgrade machinery is
  TLS 1.3 (rustls + aws-lc-rs, `prefer-post-quantum`, hybrid `X25519MLKEM768`).

## Server identity & TOFU pinning

Self-hosted servers have bare IPs — CA certificates are unavailable, so trust is
established on first use and pinned:

1. First boot: server generates
   - an **ML-DSA-65 identity keypair** → `data/identity.key`
   - a self-signed **ECDSA P-256** X.509 cert (rustls needs a classical cert;
     PQ authenticity comes from the binding signature).
2. `GET /api/v1/identity` (unauthenticated) returns:
   ```json
   { "server_name": "...", "mldsa_pubkey": "<b64url>", "cert_binding_sig": "<b64url>" }
   ```
   where `cert_binding_sig = ML-DSA-Sign(identity_key, "writform-cert-binding-v1" || SHA-256(cert SPKI))`.
3. **First connect:** client accepts the cert provisionally, fetches
   `/identity`, verifies the binding signature against the presented cert, and
   shows the user `server_name` + a short fingerprint of the ML-DSA pubkey.
   On accept, the client pins `(sha256(mldsa_pubkey), sha256(spki))`.
4. **Later connects:** presented SPKI must match the pin, OR the server may
   present a rotation statement for a new cert signed by the pinned ML-DSA key.
   A changed ML-DSA key is a hard failure: loud warning, explicit re-trust.

All client network I/O goes through the Tauri Rust core with a custom rustls
`ServerCertVerifier` — never webview `fetch` (which cannot pin).

## Passwords

`$pbkdf2-sha512$i=210000$<salt b64>$<hash b64>` — 16-byte random salt, 210k
iterations (OWASP floor), constant-time comparison. Implemented in
`crates/writform-crypto/src/password.rs`.

Tradeoff: Argon2id resists GPU attacks better but is not FIPS-approved. The
scheme name is embedded in the stored hash, so an `argon2id` server config
option can migrate users transparently on next login.

## Session tokens

Opaque 32-byte random tokens (base64url). The DB stores `SHA-256(token)` only
(`auth_sessions.token_hash`); expiry is a 30-day sliding window. Sent as
`Authorization: Bearer` (HTTP) and in the first WS frame. Revocation = row
delete. No JWT: a single server verifying its own tokens gains nothing from
signatures and loses easy revocation. Implemented in
`crates/writform-crypto/src/token.rs`.

## Test obligations (Phase 1)

- PHC round-trip + malformed/unknown-scheme rejection (done).
- Binding-signature verify + tamper cases (wrong pubkey, wrong SPKI hash,
  truncated sig).
- Integration: client with a mismatched pin must refuse to connect.
