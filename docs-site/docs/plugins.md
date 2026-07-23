# Plugins

subScribe's client is a platform: chat, sessions, notes — every feature is an
"app" registered on the same internal surface plugins use.

## Install a plugin

Copy the plugin folder (containing `manifest.json` + `main.js`) into the
app's plugin directory and enable it in the **Plugins** app:

- macOS: `~/Library/Application Support/com.writform.desktop/plugins/<id>/`
- Linux: `~/.local/share/com.writform.desktop/plugins/<id>/`
- Windows: `%APPDATA%\com.writform.desktop\plugins\<id>\`

Enabling shows the plugin's requested permissions. Plugins run with the
app's privileges (the Obsidian model) — **only install plugins you trust**.

## Bundled example: Llama AI

`examples/plugins/wf-llama` connects a group to a
[llama.cpp](https://github.com/ggml-org/llama.cpp) server. Configure the
server URL, model, and system prompt in its dock app, then ask from any
group chat:

```
/ai give me a two-sentence writing prompt about lighthouses
```

## Write your own

A plugin is evaluated with a `writform` host object and registers an
activate hook:

```js
writform.register({
  activate(ctx) {
    ctx.ui.registerMainView(() => writform.__wrapDom(myRootElement));
    ctx.commands.register({ id: "my.cmd", title: "My command", run() {} });
    ctx.chat.registerCommand({
      name: "roll",
      description: "Roll a d20",
      run: (args, chat) => chat.send(chat.channelId, `Rolled: ${1 + Math.floor(Math.random() * 20)}`),
    });
  },
});
```

Capabilities by permission: `ui` (slots + main view), `commands` (command
palette), `chat` (slash commands + posting), `net` (authenticated calls to
your subScribe server's REST API), `data` (server-side key-value storage
scoped to user/group/channel), `events` (live WebSocket events),
`vault:read` / `vault:write` (notes vault). Full reference:
`docs/plugin-api.md` in the repository.
