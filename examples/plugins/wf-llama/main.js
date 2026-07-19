// Llama AI — connect a group to a llama.cpp server (`llama-server`) and ask
// it questions from any chat with /ai. Configuration is per group, stored in
// WritForm's plugin data store; the model reply is posted back to the channel
// as a normal markdown message from whoever invoked the command.
//
// Note: talking to the llama server uses the webview's own fetch (an
// EXTERNAL address, outside WritForm's pinned channel). That is exactly what
// the "chat"+"net" permission consent covers for this plugin.

writform.register({
  activate(ctx) {
    const CONFIG_KEY = "config";
    const state = { groups: [], groupId: null };

    const defaults = () => ({
      url: "http://127.0.0.1:8080",
      model: "",
      system_prompt: "You are a concise, helpful writing assistant.",
      command: "ai",
    });

    async function loadConfig(groupId) {
      const res = await writform.net.fetch(
        "GET",
        `/api/v1/plugins/wf-llama/data/group/${groupId}/${CONFIG_KEY}`,
      );
      const value = res && res.status < 400 ? res.body : null;
      return value && typeof value === "object" ? { ...defaults(), ...value } : defaults();
    }

    async function saveConfig(groupId, config) {
      await writform.data.put("group", groupId, CONFIG_KEY, config);
    }

    async function callLlama(config, prompt) {
      const base = String(config.url || "").replace(/\/+$/, "");
      if (!base) throw new Error("no llama server configured for this group");
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model || "default",
          stream: false,
          messages: [
            { role: "system", content: config.system_prompt || "" },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(`llama server returned ${res.status}`);
      const data = await res.json();
      const reply =
        data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : null;
      if (!reply) throw new Error("llama server sent an empty reply");
      return String(reply).trim();
    }

    // ---- settings view (dock icon) ----
    const root = document.createElement("div");
    root.style.cssText =
      "padding:24px;max-width:600px;display:flex;flex-direction:column;gap:12px;color:inherit;";
    root.innerHTML = `
      <h2 style="margin:0">Llama AI</h2>
      <p style="margin:0;opacity:.7;font-size:13px">
        Point a group at a llama.cpp server (<code>llama-server -m model.gguf</code>).
        Members then ask it with <code>/ai &lt;prompt&gt;</code> in that group's chats.
        Only group admins should change these settings.
      </p>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:13px">Group
        <select data-k="group"></select></label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:13px">Llama server URL
        <input data-k="url" placeholder="http://127.0.0.1:8080"></label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:13px">Model name (as loaded by the server)
        <input data-k="model" placeholder="llama-3.1-8b-instruct"></label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:13px">System prompt
        <textarea data-k="system_prompt" rows="4"></textarea></label>
      <div style="display:flex;gap:8px;align-items:center">
        <button data-k="save">Save for this group</button>
        <button data-k="test">Test connection</button>
        <span data-k="status" style="font-size:12px;opacity:.7"></span>
      </div>`;
    const el = (k) => root.querySelector(`[data-k="${k}"]`);
    const setStatus = (text) => {
      el("status").textContent = text;
    };

    async function showGroup(groupId) {
      state.groupId = groupId;
      const config = await loadConfig(groupId);
      el("url").value = config.url;
      el("model").value = config.model;
      el("system_prompt").value = config.system_prompt;
      setStatus("");
    }

    el("group").addEventListener("change", (e) => {
      void showGroup(Number(e.target.value));
    });
    el("save").addEventListener("click", async () => {
      if (state.groupId === null) return;
      await saveConfig(state.groupId, {
        url: el("url").value.trim(),
        model: el("model").value.trim(),
        system_prompt: el("system_prompt").value,
        command: "ai",
      });
      setStatus("Saved ✓");
    });
    el("test").addEventListener("click", async () => {
      setStatus("Testing…");
      try {
        const reply = await callLlama(
          {
            url: el("url").value.trim(),
            model: el("model").value.trim(),
            system_prompt: "Reply with the single word: ready",
          },
          "Are you there?",
        );
        setStatus(`Server replied: ${reply.slice(0, 60)}`);
      } catch (e) {
        setStatus(`Failed: ${e && e.message ? e.message : e}`);
      }
    });

    void (async () => {
      const res = await writform.net.fetch("GET", "/api/v1/groups");
      state.groups = res && res.status < 400 && Array.isArray(res.body) ? res.body : [];
      el("group").innerHTML = state.groups
        .map((g) => `<option value="${g.id}">${g.name.replace(/</g, "&lt;")}</option>`)
        .join("");
      if (state.groups.length > 0) void showGroup(state.groups[0].id);
      else setStatus("Join or create a group first.");
    })();

    ctx.ui.registerMainView(() => writform.__wrapDom(root));

    // ---- /ai chat command ----
    ctx.chat.registerCommand({
      name: "ai",
      description: "Ask the group's Llama model (set up in the Llama AI app)",
      run: async (args, cctx) => {
        const prompt = args.trim();
        if (!prompt) throw new Error("usage: /ai <prompt>");
        if (cctx.groupId === null) {
          throw new Error("/ai works in group chats (it uses the group's configuration)");
        }
        const config = await loadConfig(cctx.groupId);
        const reply = await callLlama(config, prompt);
        const label = config.model || "llama";
        await cctx.send(`🤖 **${label}** · _${prompt.slice(0, 120)}_\n${reply}`);
      },
    });
  },
});
