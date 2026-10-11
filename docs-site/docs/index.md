# subScribe

subScribe is a **writing suite you own**. It has documents and book
publishing, boards, and notes that work on your own device with no account
and no connection. When you want to write with other people, it adds a
**self-hosted server** for chat, voice, live sessions and shared documents.
One of you runs the server (one click, inside the app) and everyone else
connects to that address. Nothing touches a third-party cloud: what you
write lives on your device, or on the server you and your friends run.

Open the app and you're at **Home**: start a document, a board or a note,
pick up what you were last working on, or join the people you write with.

## What's inside

- **Writing sessions**: WYSIWYG prompts (formatting + images), optional
  timers and live side-chat, with everything recorded and browsable forever
- **Documents**: live collaborative editing, writing formats (screenplay,
  stage play, manuscript, poetry), version history, folders, search,
  anchored feedback threads, file import, sharing with friends or groups
- **Chat**: Discord-style groups with channels, markdown, custom emotes,
  @mentions and #channel references, image uploads, slash commands
- **Voice**: audio channels over peer-to-peer WebRTC (the server only relays
  signaling), with per-device input/output settings
- **Canvas**: shared storyboards with stickies, colored frames, connectors,
  images, link cards and live document references
- **Notes**: an Obsidian-compatible local vault with `[[wiki-links]]` and
  notes you can share with friends
- **Plugins**: every feature is an app on an internal platform, and you can
  add your own (see [Plugins](plugins.md))

Presence status (online/busy/invisible), profile cards, and native
notifications for DMs, mentions, sessions, and shares round out the day-to-day
experience.

## Security in one paragraph

Connections use TLS 1.3 with **hybrid post-quantum key exchange**
(X25519MLKEM768) and the server proves its identity with an **ML-DSA-65**
signature pinned on first connect. If a server's identity key ever changes,
the app warns you loudly. Passwords are stored as PBKDF2-HMAC-SHA-512
hashes. Login tokens are opaque and revocable per device. Details in the
repository's `docs/crypto.md`.

Start with [Setup](setup.md).
