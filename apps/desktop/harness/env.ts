// The few browser globals app modules reach for at import time, so they
// load in Node. Import this first in a harness.

import { readFileSync } from "node:fs";

const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
g.location ??= {
  origin: "http://localhost",
  href: "http://localhost/",
  protocol: "http:",
  host: "localhost",
  hostname: "localhost",
  search: "",
  hash: "",
  pathname: "/",
};
const store = new Map<string, string>();
g.localStorage ??= {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// Bundled assets are `file://` URLs here (see run.mjs).
const realFetch = globalThis.fetch;
g.fetch = async (input: unknown, init?: unknown) => {
  const url = String(input);
  if (!url.startsWith("file://")) return realFetch(input as never, init as never);
  const buf = readFileSync(new URL(url));
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

/** PASS/FAIL lines and the exit code every harness ends with. */
let failures = 0;
export function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
export function finish(): never {
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
