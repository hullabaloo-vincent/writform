# Networking

## The model

- The **client never trusts the network**: every HTTP/WebSocket call goes
  through the app's Rust core over TLS 1.3 with hybrid post-quantum key
  exchange, pinned to the server's ML-DSA identity (trust-on-first-use).
- The **server** is a single process listening on one TCP port
  (default `7311`).
- **Voice media** is the exception by design: audio flows directly between
  members (WebRTC/DTLS-SRTP); only the signaling goes through the server.

## Same network (LAN)

Share your LAN address (shown on the hosting card, e.g.
`192.168.1.20:7311`). Nothing else to configure.

## Over the internet

Pick one:

1. **Tailscale / WireGuard (recommended)** — put host and friends on a
   tailnet and share your Tailscale IP. No ports opened, works through any
   NAT, and voice traffic benefits too.
2. **Port forwarding** — forward TCP `7311` on your router to the hosting
   machine and share your public IP. The app attempts a **UPnP** mapping
   automatically when hosting and shows the result.
3. **A VPS** — run `writform-server` (or the Docker image) on a small cloud
   box; everyone connects to its address.

## Voice reachability

Peers connect directly, using STUN to discover their public addresses. On a
LAN or tailnet this always works. Across the open internet, two symmetric
NATs may fail to connect — a TURN relay is the standard fix and is on the
roadmap; until then, Tailscale is the reliable path.

## What a fingerprint change means

If the app warns that a server's **identity changed**, either the host
reinstalled the server (new identity key) — confirm with them out of band —
or someone is intercepting the connection. Don't accept a changed identity
you can't explain.
