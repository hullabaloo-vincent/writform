/**
 * Follow a link out of the app: a web page in the system's browser, an
 * email in the mail program, a number in the phone. In the desktop and
 * mobile apps the webview must not navigate away (it is the app), so the
 * system is asked to open it; in the browser client it's a new tab.
 */
export async function openLink(href: string): Promise<void> {
  if (!/^(https?:\/\/|mailto:|tel:)/i.test(href)) {
    throw { code: "bad_link", message: "That link doesn't go anywhere the app can open." };
  }
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
