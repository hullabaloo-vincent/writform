# Networking

## The model

- The **client never trusts the network**: every HTTP/WebSocket call goes
  through the app's Rust core over TLS 1.3 with hybrid post-quantum key
  exchange, pinned to the server's ML-DSA identity (trust-on-first-use).
- The **server** is a single process listening on one TCP port
  (default `7311`).
- **Voice media** is the exception by design: audio flows directly between
  members (WebRTC/DTLS-SRTP) and only the signaling goes through the server.

## Same network (LAN)

Share your LAN address (shown on the hosting card, e.g.
`192.168.1.20:7311`). Nothing else to configure.

## Over the internet

Pick one:

1. **Tailscale / WireGuard (recommended)**: put host and friends on a
   tailnet and share your Tailscale IP. No ports opened, works through any
   NAT, and voice traffic benefits too.
2. **Port forwarding**: forward TCP `7311` on your router to the hosting
   machine and share your public IP. The app attempts a **UPnP** mapping
   automatically when hosting and shows the result. The hosting card also
   shows your public address for friends.
3. **A VPS**: run `writform-server` (or the Docker image) on a small cloud
   box, and everyone connects to its address.

### Testing a port forward

Test from **outside** your own network: a port-checking website, or a phone
on cellular data (opening `https://your-ip:7311/api/v1/healthz`, where the
certificate warning itself proves the port is open). Dialing your own
public IP from inside the same network often fails ("NAT hairpinning")
even when the forward is correct, so it proves nothing. Keep hosting
running during the test, and give the hosting machine a fixed LAN address
(a DHCP reservation) so the forward doesn't silently break later.

### When port forwarding can't work: CGNAT and double NAT

Compare the **WAN/Internet address on your router's status page** with the
public IP the hosting card shows. If they differ, inbound connections are
dropped before they ever reach your router:

- WAN address in `100.64.x`–`100.127.x` (or your ISP confirms
  **carrier-grade NAT**): no router setting can fix this. Ask the ISP for
  a public IP, or use Tailscale (option 1 above), which needs no router
  changes at all.
- WAN address in `192.168.x` / `172.16–31.x`: **double NAT**, which means
  another ISP box sits in front of your router. Forward TCP `7311` on that
  upstream box to your router's WAN address (keeping your existing rule),
  or put the upstream box in bridge mode.

## Keep your server's address private

With port forwarding or a VPS, anyone who has your server's address knows
where it is. To keep that to yourself, put a proxy in front of it, such as
Cloudflare. People then connect to a name (`chat.example.com`) and only the
proxy knows the address behind it.

**Cloudflare Tunnel (recommended).** Nothing is opened on your router.

1. Start the server with `WRITFORM_TLS=off`. The tunnel speaks TLS to
   everyone, and the server talks to the tunnel on this machine only.
   (Or keep TLS on and set `noTLSVerify: true` for it in the tunnel's
   settings: the server's own certificate is self-signed.)
2. In Cloudflare, make a tunnel with `cloudflared` and point a public
   hostname at `http://localhost:7311`.
3. Set `WRITFORM_TRUST_PROXY=cloudflare` so the server sees each person's
   own address (for its limits on sign-in attempts), not the tunnel's.
4. People connect to `https://chat.example.com`.

**A proxied DNS record (the orange cloud).**

1. Cloudflare passes on only some ports. Run the server on 443 (with
   Docker, `-p 443:7311`) or on 8443, and give people
   `https://chat.example.com` or `chat.example.com:8443`.
2. Set SSL/TLS to **Full** in Cloudflare, not Full (strict). The server's
   own certificate is self-signed.
3. Set `WRITFORM_TRUST_PROXY=cloudflare`.
4. Let only Cloudflare's addresses reach that port in your firewall.
   Otherwise the server can still be found by scanning for it. Make sure no
   other DNS record (an unproxied one, or a mail record) points at the same
   address.

**What changes for people connecting.** The first connection still shows
the server's fingerprint to check. Through a proxy the app can't pin the
server's own certificate (it sees Cloudflare's), so the certificate must be
a valid public one for that name, and the server proves its identity with a
fresh signature each time someone signs in. The proxy can read what passes
through it, as with any website behind Cloudflare. A server reached directly
keeps the stronger pinned connection. An address typed without a port tries
7311 and then 443. One that starts with `https://` goes to 443.

**Other ways the address can show.**

- **Link previews.** The server fetches the links members post to show a
  preview, and each site it fetches sees its address. Set
  `WRITFORM_LINK_PREVIEWS=off` to stop it.
- **Fonts.** The server fetches font files from jsDelivr, a public CDN. Set
  `WRITFORM_FONT_PROXY=off` if you'd rather it didn't.
- **Voice** goes straight between members, so members see each other's
  addresses (never the server's).

## Voice reachability

Peers connect directly, using STUN to discover their public addresses. On a
LAN or tailnet this always works. Across the open internet, two symmetric
NATs may fail to connect. A TURN relay is the standard fix and is on the
roadmap. Until then, Tailscale is the reliable path.

## What a fingerprint change means

If the app warns that a server's **identity changed**, either the host
reinstalled the server (new identity key) or someone is intercepting the
connection. Confirm with the host out of band. Don't accept a changed
identity you can't explain.
