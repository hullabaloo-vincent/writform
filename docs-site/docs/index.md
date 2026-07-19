# WritForm

WritForm is a **self-hosted group creative-writing app**. One of you runs the
server (one click, inside the app); everyone else connects to your address.
Nothing touches a third-party cloud: writing, chat, voice signaling, and
files all live on the server you run.

## What's inside

- ✍️ **Writing sessions** — WYSIWYG prompts (formatting + images), optional
  timers, live side-chat, everything recorded and browsable forever
- 💬 **Chat** — Discord-style groups with channels, markdown, custom emotes,
  image uploads, slash commands
- 🔊 **Voice** — audio channels; peer-to-peer WebRTC, the server only relays
  signaling
- 🎨 **Canvas** — shared storyboards: stickies, frames, connectors, images,
  link cards
- 📓 **Notes** — an Obsidian-compatible local vault with `[[wiki-links]]`,
  shareable to friends
- 🧩 **Plugins** — every feature is an app on an internal platform; you can
  add your own (see [Plugins](plugins.md))

## Security in one paragraph

Connections use TLS 1.3 with **hybrid post-quantum key exchange**
(X25519MLKEM768) and the server proves its identity with an **ML-DSA-65**
signature pinned on first connect — if a server's identity key ever changes,
the app warns you loudly. Passwords are stored as PBKDF2-HMAC-SHA-512
hashes; login tokens are opaque and revocable per device. Details in the
repository's `docs/crypto.md`.

Start with [Setup](setup.md).
