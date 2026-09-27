/** Keyboard avoidance for the native mobile shell.
 *
 *  In Safari and the installed PWA, `100dvh` shrinks when the on-screen
 *  keyboard appears, so the composer rides its top edge for free. An
 *  embedded WKWebView never resizes for the keyboard — it overlays the
 *  page and WebKit "helpfully" scrolls the window instead. Mirror the
 *  visual viewport's shortfall into a CSS inset the shell pads itself
 *  with, and pin the window scroll WebKit keeps trying to add. */

import { isMobileApp } from "./backend";

export function installKeyboardInset(): () => void {
  const vv = window.visualViewport;
  if (!isMobileApp || !vv) return () => {};

  const apply = () => {
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--wf-kb-inset", `${inset}px`);
    window.scrollTo(0, 0);
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    document.documentElement.style.removeProperty("--wf-kb-inset");
  };
}
