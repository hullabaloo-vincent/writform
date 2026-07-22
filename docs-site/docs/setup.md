# Setup

## Installing

**Windows and Linux** have prebuilt installers on the
[latest release](https://github.com/hullabaloo-vincent/writform/releases/latest) —
download the one for your platform and run it.

**macOS builds from source.** A notarized download needs a paid Apple Developer
membership, and this is a free open-source project; an unnotarized `.app`
downloaded from the internet would be blocked by Gatekeeper. Building on your own
Mac sidesteps that completely — locally compiled apps are never quarantined, so
the result opens like any other app. See below.

## Building on macOS

You do not need to know Rust — the script checks for everything and offers to
install anything missing.

1. Download the source (**Code → Download ZIP** on GitHub, or `git clone`).
2. Open the `scripts` folder.
3. Double-click **Build WritForm (macOS).command**.

It verifies Xcode Command Line Tools, Node, and Rust, installs whatever is
absent (asking first), builds the app, and offers to move it to Applications.
The first build takes several minutes because Rust compiles from scratch;
later builds are much quicker.

If Finder refuses to run the script because it came from a ZIP download, either
run `xattr -dr com.apple.quarantine` on the folder, or start it from Terminal:

```sh
./scripts/"Build WritForm (macOS).command"
```

### Microphone or camera prompt never appears

macOS records permission decisions per app identity. If a previous build was
ever denied (or a stale record exists), the built app is refused instantly
with no prompt — and locally built apps sometimes don't even appear in
System Settings → Privacy & Security. Clear the stale records and relaunch:

```sh
tccutil reset Microphone com.writform.desktop
tccutil reset Camera com.writform.desktop
```

The next time WritForm asks, the real system prompt appears.

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
