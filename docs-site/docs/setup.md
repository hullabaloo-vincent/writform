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
docker run -d --name writform --restart unless-stopped \
  -p 7311:7311 -v writform:/data ghcr.io/hullabaloo-vincent/writform-server
```

A systemd unit ships in the repo under `deploy/`. For upgrading either
flavor, see [Updating a server](#updating-a-server) below.

## Updates

The desktop app updates itself from GitHub Releases (Settings →
Application → **Check for updates**); packages are signature-verified before
installing.

## Updating a server

Everything that makes your server *your* server — the identity key behind
the fingerprint, the TLS certificate, the account database, and uploaded
attachments — lives in the **data directory**, not in the binary or the
container. As long as you keep that directory, you can swap the server
underneath it freely: the fingerprint stays the same, nobody has to re-pair
or re-register, and database migrations run automatically the first time
the new version starts.

### Docker

Containers are disposable; the named volume (`writform` below) is what
carries your data. An update is: pull the new image, replace the container,
keep the volume.

```sh
docker pull ghcr.io/hullabaloo-vincent/writform-server
```

```sh
docker stop writform && docker rm writform
```

```sh
docker run -d --name writform --restart unless-stopped \
  -p 7311:7311 -v writform:/data ghcr.io/hullabaloo-vincent/writform-server
```

(If you started the old container without `--name`, find its generated name
with `docker ps` first.)

`docker rm` deletes only the container layer — the volume is untouched. The
only commands that would reset your server's identity are
`docker volume rm writform` or a `docker run` without the `-v writform:/data`
mount, which starts from a blank data directory. Neither is ever part of an
update.

### Bare binary

Replace `writform-server` with the new release's binary and restart it (or
`systemctl restart writform-server` if you use the shipped unit), keeping
the same `--data-dir`.

### Verifying

Connect from the app. Connecting cleanly *is* the fingerprint check —
clients pin the server identity and warn loudly if it changed. Where to
check versions: the server prints its version at startup, and a client
that's newer than the server will tell you when it needs something the
server doesn't have yet ("the server is running an older WritForm
version…") — that message is the cue to run the update above.

**Permission denied on an old volume:** volumes first created by releases up
through v0.5.0 are owned by root, so after an update the (unprivileged)
server can exit with `permission denied (os error 13)`. Fix the ownership
once and it stays fixed:

```sh
docker run --rm --user root --entrypoint chown \
  -v writform:/data ghcr.io/hullabaloo-vincent/writform-server -R writform /data
```
