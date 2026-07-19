// WritForm example plugin: a personal scratchpad that syncs through the
// server's plugin-data API (user scope). Demonstrates: register + activate,
// a main view via React-free DOM, commands, and plugin_data persistence.
//
// Install: copy this folder into {app_data_dir}/plugins/wf-scratchpad/ and
// enable it in the Plugins app.

writform.register({
  activate(ctx) {
    // The platform hands plugins plain DOM containers through a render
    // function; we return a React element built with createElement via the
    // host's helper-free path: a simple function component using strings.
    // (Core apps use JSX; plugins can ship anything that returns valid nodes.)
    const React = writform.__react ?? null;

    ctx.ui.registerMainView(() => {
      // Build with raw DOM inside an effect-free wrapper element.
      const container = document.createElement("div");
      container.style.maxWidth = "640px";
      container.style.margin = "0 auto";

      const h = document.createElement("h2");
      h.textContent = "🗒️ Scratchpad (plugin)";
      const status = document.createElement("p");
      status.style.opacity = "0.6";
      status.textContent = "loading…";
      const area = document.createElement("textarea");
      area.style.width = "100%";
      area.style.height = "300px";
      area.style.background = "var(--wf-bg-raised)";
      area.style.color = "var(--wf-text)";
      area.style.border = "1px solid var(--wf-border)";
      area.style.borderRadius = "10px";
      area.style.padding = "12px";

      const userId = writform.manifest.__user_id ?? 0;
      let timer = null;

      async function load() {
        try {
          const me = await writform.net.fetch("GET", "/api/v1/auth/me");
          const uid = me.body.id;
          const value = await writform.data.get("user", uid, "scratch");
          area.value = typeof value === "string" ? value : "";
          status.textContent = "synced through the server (user scope)";
          area.addEventListener("input", () => {
            status.textContent = "typing…";
            clearTimeout(timer);
            timer = setTimeout(async () => {
              await writform.data.put("user", uid, "scratch", area.value);
              status.textContent = "saved ✓";
            }, 800);
          });
        } catch (e) {
          status.textContent = "could not load scratchpad: " + (e && e.message ? e.message : e);
        }
      }
      load();

      container.append(h, status, area);
      // The slot system renders React nodes; a raw element is wrapped by the
      // host into a passthrough component.
      return writform.__wrapDom ? writform.__wrapDom(container) : container;
    });
  },
});
