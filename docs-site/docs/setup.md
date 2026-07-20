# Setup

## Installing on macOS

WritForm is signed, but not *notarized* — notarization requires a paid Apple
Developer membership, and this is a free open-source project. macOS therefore
asks for confirmation the first time you open a downloaded copy.

There are two ways around that. Pick whichever you prefer.

### Option 1 — build it yourself (no warnings at all)

Apps compiled on your own Mac are never quarantined, so this route produces an
app that opens like any other. You do not need to know Rust — the script checks
for everything and offers to install anything missing.

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

### Option 2 — use the prebuilt download

After dragging WritForm to Applications, run this once:

```sh
xattr -dr com.apple.quarantine /Applications/WritForm.app
```

That clears the "downloaded from the internet" flag and the app opens normally
from then on. Alternatively, open it once and choose **Open Anyway** in
**System Settings → Privacy & Security**.

**Note:** on macOS 15 (Sequoia) and later the old Control-click → **Open**
shortcut no longer works — use the command above or the Privacy & Security
panel.

Building from source or installing with `brew install --cask --no-quarantine`
skips this entirely, since the flag is only applied to browser downloads.

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
