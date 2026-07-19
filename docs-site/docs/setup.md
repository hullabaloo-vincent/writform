# Setup

## Host on this computer (easiest)

1. Install WritForm and open it.
2. Choose **Host on this computer**, pick a server name and port
   (default `7311`), and press **Start hosting**.
3. Create the first account — the first registration becomes the
   **server admin**.
4. Open the server card on the connect screen (or Settings → Server) for
   the addresses to share with friends.

Your server starts automatically whenever the app runs. Data lives in the
app's data directory under `server/`.

## Join someone's server

1. Choose **Join a server** and enter the address they gave you
   (e.g. `192.168.1.20:7311`).
2. Compare the **identity fingerprint** the app shows with the one your host
   sees — this is the trust-on-first-use check.
3. Create your account on that server.

## Standalone server (optional)

For an always-on machine, run the bare server instead of the app:

```sh
writform-server --data-dir /var/lib/writform --port 7311
# or
docker run -p 7311:7311 -v writform:/data ghcr.io/hullabaloo-vincent/writform-server
```

A systemd unit ships in the repo under `deploy/`. Upgrading is
swap-binary-and-restart; database migrations run automatically at startup.

## Updates

The desktop app updates itself from GitHub Releases (Settings →
Application → **Check for updates**); packages are signature-verified before
installing.
