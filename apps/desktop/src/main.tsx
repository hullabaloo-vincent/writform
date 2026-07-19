import React from "react";
import ReactDOM from "react-dom/client";

import { canvasApp } from "./apps/canvas";
import { chatApp } from "./apps/chat";
import { friendsApp } from "./apps/friends";
import { notesApp } from "./apps/notes";
import { pluginManagerApp } from "./apps/pluginmanager";
import { settingsApp } from "./apps/settings";
import { sessionsApp } from "./apps/sessions";
import { registerApp } from "./platform";
import { loadEnabledPlugins } from "./platform/pluginHost";
import { Root } from "./Root";
import "./styles.css";

// Core apps register here, in dock order. Third-party plugins load through
// the plugin runtime (Phase 6) onto the same registry.
registerApp(chatApp);
registerApp(sessionsApp);
registerApp(canvasApp);
registerApp(friendsApp);
registerApp(notesApp);
registerApp(pluginManagerApp);
registerApp(settingsApp);

// Third-party plugins join the same registry after user-granted consent.
void loadEnabledPlugins();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
