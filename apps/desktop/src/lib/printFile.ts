/**
 * Printing a finished PDF. The app typesets its own pages, so "Print" is
 * handing that PDF to whatever prints on this device: the native panel on
 * macOS, the system sheet on an iPhone, the webview's own PDF printing on
 * Windows and the web — and, where none of those work, the system viewer
 * or the share sheet, which can.
 */

import { backend, isCmdError } from "./backend";

export type PrintOutcome =
  /** A print panel ran (or is up): nothing more to say. */
  | "printed"
  | "cancelled"
  /** Opened somewhere that can print it. */
  | "opened"
  | "shared"
  | "failed";

let frame: HTMLIFrameElement | null = null;
let frameUrl: string | null = null;

function dropFrame() {
  frame?.remove();
  frame = null;
  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frameUrl = null;
}

/** Print the PDF from a hidden frame (Chromium, WebView2, desktop Safari
 *  and Firefox show the system print dialog for it). */
function printInFrame(bytes: Uint8Array): Promise<boolean> {
  dropFrame();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const el = document.createElement("iframe");
  // Off-screen but rendered: a `display: none` frame prints blank in some
  // engines.
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:1000px;border:0;opacity:0;pointer-events:none";
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  frame = el;
  frameUrl = url;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    el.onload = () => {
      // The PDF viewer inside the frame needs a moment to be ready.
      setTimeout(() => {
        try {
          const win = el.contentWindow;
          if (!win) throw new Error("no frame");
          win.focus();
          win.print();
          done(true);
        } catch {
          done(false);
        }
      }, 400);
    };
    el.onerror = () => done(false);
    setTimeout(() => done(false), 8000);
    el.src = url;
    document.body.appendChild(el);
  });
}

function canShare(file: File): boolean {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

const isPhoneLike = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));

/**
 * Print `bytes` (a PDF) titled `title`. Call it straight from the tap or
 * click that asks for it, with the PDF already built: the share sheet and
 * a new tab only open from a user's gesture.
 */
export async function printPdf(bytes: Uint8Array, title: string): Promise<PrintOutcome> {
  const name = `${title.trim() || "Document"}.pdf`;
  const share = async (): Promise<PrintOutcome> => {
    const file = new File([bytes as BlobPart], name, { type: "application/pdf" });
    if (!canShare(file)) return "failed";
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (e) {
      return (e as { name?: string } | null)?.name === "AbortError" ? "cancelled" : "failed";
    }
  };

  // A phone's browser can't print a PDF from a frame; its share sheet can.
  const phone = isPhoneLike();
  let how: string;
  try {
    how = await backend.printPdf(title, bytes);
  } catch (e) {
    if (isCmdError(e) && e.code === "print_unavailable") return share();
    how = "frame";
  }
  if (how === "printed" || how === "presented") return "printed";
  if (how === "cancelled") return "cancelled";
  if (how === "opened") return "opened";

  if (phone) {
    const shared = await share();
    if (shared !== "failed") return shared;
  } else if (await printInFrame(bytes)) {
    return "printed";
  }
  // Last resort: show the PDF itself; its viewer has a Print button.
  try {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const opened = window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return opened ? "opened" : "failed";
  } catch {
    return "failed";
  }
}
