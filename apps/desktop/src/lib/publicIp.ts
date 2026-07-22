/**
 * Public IP discovery via STUN — the same server the voice mesh already
 * uses, so hosting reachability phones no NEW third party. A server-reflexive
 * ICE candidate carries our address as the internet sees it.
 *
 * This is the IP friends connect to once the port forward exists; it can't
 * tell whether the forward works (that needs an outside probe).
 */

let cached: Promise<string | null> | null = null;

export function discoverPublicIp(): Promise<string | null> {
  cached ??= probe().then((ip) => {
    if (ip === null) cached = null; // failed probes may retry later
    return ip;
  });
  return cached;
}

function probe(): Promise<string | null> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (ip: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        // already closed
      }
      resolve(ip);
    };
    const timer = setTimeout(() => finish(null), 4000);

    pc.onicecandidate = (e) => {
      const cand = e.candidate?.candidate ?? "";
      if (!cand.includes(" typ srflx ")) return;
      // candidate fields: foundation component proto priority ADDRESS PORT typ …
      const address = cand.split(" ")[4];
      // IPv4 only — a v6 address is useless to a friend whose network lacks v6.
      if (address && !address.includes(":")) finish(address);
    };
    pc.createDataChannel("probe");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => finish(null));
  });
}
