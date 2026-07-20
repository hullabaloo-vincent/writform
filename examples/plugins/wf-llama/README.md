# Llama AI plugin for WritForm

Connects a group to a [llama.cpp](https://github.com/ggml-org/llama.cpp)
server so anyone in the group can ask the model from chat with `/ai`.

## 1. Run a llama server

```sh
llama-server -m /path/to/model.gguf --port 8080
```

Any server exposing the OpenAI-compatible `/v1/chat/completions` endpoint
works (llama.cpp `llama-server`, Ollama with `/v1`, LM Studio, vLLM, …).

## 2. Install the plugin

Copy this folder into WritForm's plugin directory and enable it:

- macOS: `~/Library/Application Support/com.writform.desktop/plugins/wf-llama/`
- Linux: `~/.local/share/com.writform.desktop/plugins/wf-llama/`
- Windows: `%APPDATA%\com.writform.desktop\plugins\wf-llama\`

Then open the **Plugins** app inside WritForm, enable **Llama AI**, and reload
when prompted. Enabling shows the permission list — this plugin uses `chat`
(register the `/ai` command and post replies), `net`/`data` (store per-group
settings on your WritForm server), and it talks to your llama server directly
from the app.

## 3. Configure a group

Open the **Llama AI** icon in the dock, pick a group, and set:

- **Llama server URL** — e.g. `http://127.0.0.1:8080` (a LAN address works if
  everyone should share one machine's model)
- **Model name** — passed through to the server (informational for llama.cpp)
- **System prompt** — the model's standing instructions

Use **Test connection** to verify, then **Save for this group**. Settings are
stored per group on your WritForm server; only group admins should edit them.

## 4. Ask away

In any of that group's chats:

```
/ai give me a two-sentence writing prompt about lighthouses
```

The reply is posted to the channel as a markdown message (prefixed with a
robot emoji and the model name), sent by whoever invoked the command.
