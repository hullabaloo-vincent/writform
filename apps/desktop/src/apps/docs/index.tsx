import { BookOpen } from "lucide-react";
import { marked } from "marked";
import { useMemo, useState } from "react";

import type { WritformApp } from "../../platform";

/**
 * In-app documentation. The pages are the SAME markdown files that build the
 * static MkDocs site (docs-site/) — one source of truth, two renderers.
 * Content is authored in this repo, so rendering its HTML directly is safe.
 */

const raw = import.meta.glob("../../../../../docs-site/docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const NAV: { file: string; title: string }[] = [
  { file: "index.md", title: "Welcome" },
  { file: "setup.md", title: "Setup" },
  { file: "features.md", title: "Features" },
  { file: "how-to.md", title: "How-to" },
  { file: "plugins.md", title: "Plugins" },
  { file: "endpoints.md", title: "Endpoints" },
  { file: "networking.md", title: "Networking" },
];

function pageSource(file: string): string {
  const key = Object.keys(raw).find((k) => k.endsWith(`/${file}`));
  return key ? raw[key] : `# Missing page\n\n\`${file}\` was not bundled.`;
}

function DocsView() {
  const [active, setActive] = useState("index.md");
  const html = useMemo(() => {
    // Internal links between pages stay in-app.
    const src = pageSource(active);
    return marked.parse(src, { async: false });
  }, [active]);

  return (
    <div className="wf-docs">
      <nav className="wf-docs-nav">
        <h3>Documentation</h3>
        {NAV.map((p) => (
          <button
            key={p.file}
            className={active === p.file ? "active" : ""}
            onClick={() => setActive(p.file)}
          >
            {p.title}
          </button>
        ))}
        <p className="wf-docs-note">
          Also deployable as a website — see <code>docs-site/</code>.
        </p>
      </nav>
      <article
        className="wf-docs-body"
        onClick={(e) => {
          // Intercept .md links so navigation stays inside the app.
          const a = (e.target as HTMLElement).closest("a");
          if (!a) return;
          const href = a.getAttribute("href") ?? "";
          const inApp = NAV.find((p) => href === p.file || href.endsWith(`/${p.file}`));
          if (inApp) {
            e.preventDefault();
            setActive(inApp.file);
          }
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export const docsApp: WritformApp = {
  manifest: {
    id: "writform.docs",
    name: "Docs",
    icon: <BookOpen size={20} />,
    permissions: ["ui", "commands"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <DocsView />);
    ctx.commands.register({
      id: "docs.open",
      title: "Docs: Open",
      run: () => {
        void import("../../platform").then(({ usePlatform }) =>
          usePlatform.getState().setActiveApp("writform.docs"),
        );
      },
    });
  },
};
