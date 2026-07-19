# WritForm plugin API (v1)

WritForm's client is a platform: chat, sessions, notes — every built-in
feature is an "app" on an internal extension-point layer, and third-party
plugins use the **same surface**.

## Anatomy

A plugin is a folder installed at `{app_data_dir}/plugins/<id>/`:

```
wf-myplugin/
├── manifest.json
└── main.js
```

`manifest.json`:

```json
{
  "id": "wf-myplugin",            // must equal the folder name
  "name": "My Plugin",
  "version": "0.1.0",
  "icon": "🧩",                    // dock emoji
  "permissions": ["ui", "commands", "net", "data"],
  "min_api_version": 1
}
```

Users enable plugins in the **Plugins** app; the permission list is shown at
enable time and changes take effect after a reload.

## Runtime

`main.js` is evaluated with one global argument, `writform`:

```js
writform.register({
  activate(ctx) {
    // ctx carries permission-gated ui/commands surfaces
    ctx.ui.registerMainView(() => writform.__wrapDom(myRootElement));
    ctx.commands.register({ id: "myplugin.hello", title: "My Plugin: Hello", run() {} });
  },
});
```

Capabilities appear on `writform` **only if declared** in the manifest:

| Permission | Surface |
|------------|---------|
| `ui` | `ctx.ui.addToSlot(slot, contribution)`, `ctx.ui.registerMainView(render)` — slots: `nav.rail`, `panel.right`, `statusbar`, `settings.section` |
| `commands` | `ctx.commands.register/execute` (command palette integration) |
| `net` | `writform.net.fetch(method, path, body)` — **only** `/api/v1/` paths on the connected server, over the pinned TLS client |
| `data` | `writform.data.get/put/list(scope, scopeId, key)` — server-side JSON storage scoped to `user` / `group` / `channel`, membership-checked server-side; updates fan out as `plugin_data.updated` WS events |
| `events` | `writform.events.onWsEvent(handler)`, `writform.events.sub(rooms)` |
| `vault:read` / `vault:write` | `writform.vaultRead.list/read`, `writform.vaultWrite.write` |

Helpers always present: `writform.apiVersion`, `writform.manifest`,
`writform.__wrapDom(element)` (render plain DOM inside the React shell).

Custom message kinds: post messages with `kind = "plugin:<id>:<type>"`;
clients without the plugin render a graceful fallback card.

## Security model (read this)

WritForm plugins follow the **Obsidian model**: consent-based, not a hard
sandbox. Plugin code runs inside the app's webview with the app's privileges —
the permission list controls which *conveniences* are handed to it, and the
enable-time prompt makes the request visible, but a malicious plugin is
malicious code on your machine. Install plugins you trust, from people you
trust.

What the platform does enforce:

- Plugins are **disabled by default**; enabling shows the permission list.
- `writform.net.fetch` refuses non-`/api/v1/` paths and only ever reaches the
  currently connected, pinned server (the webview has no other network path).
- `plugin_data` is scoped server-side: user scope is yours alone; group and
  channel scopes require membership, enforced by the server, not the client.
- A manifest whose `id` doesn't match its folder, or with an invalid id, is
  ignored.

## Example

See [`examples/plugins/wf-scratchpad/`](../examples/plugins/wf-scratchpad/) —
a synced scratchpad in ~60 lines: main view, autosave, `plugin_data` (user
scope) persistence through the server.
