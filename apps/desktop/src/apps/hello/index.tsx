import { useState } from "react";

import type { WritformApp } from "../../platform";

/**
 * Demo core app proving the platform layer end to end: rail icon + main view
 * via `registerMainView`, a statusbar contribution, and a palette command.
 * Dies once the first real app (chat, Phase 2) lands.
 */

function HelloView() {
  const [count, setCount] = useState(0);
  return (
    <div className="wf-hello">
      <h1>Hello, WritForm</h1>
      <p>
        This view is rendered through the platform's <code>main.view</code> slot — the same
        extension point chat, sessions, notes, and third-party plugins will use.
      </p>
      <p>
        Press <kbd>⌘K</kbd> to open the command palette.
      </p>
      <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
    </div>
  );
}

export const helloApp: WritformApp = {
  manifest: {
    id: "writform.hello",
    name: "Hello",
    icon: "👋",
    permissions: ["ui", "commands"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <HelloView />);
    ctx.ui.addToSlot("statusbar", {
      id: "writform.hello/status",
      render: () => <span>WritForm dev shell</span>,
    });
    ctx.commands.register({
      id: "hello.greet",
      title: "Hello: Show greeting",
      run: () => window.alert("Hello from the command registry!"),
    });
  },
};
