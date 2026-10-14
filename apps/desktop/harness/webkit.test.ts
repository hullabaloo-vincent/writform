// The app's floor is Safari 15 (iOS 15). Two kinds of syntax newer than
// that stop a whole file from being read there, whatever the code around
// them does: a class static block, and a look-behind in a regular
// expression. Our own source keeps clear of both, but what we bundle may
// not (pdf.js ships a static block in its "legacy" build, and for a while
// that meant no PDF could be opened on iOS 15 at all).
//
// The build is told the floor (vite.config.ts) and lowers what it can.
// This reads what the build made and holds it to that. It also holds the
// PDF reader's loader to going through the build.
//
// It reads `dist/`, so it says something only after `npm run build` (the
// gate builds before it runs the harnesses).

import { check as report, finish } from "./env";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** (What was found is only worth printing when something was.) */
const check = (name: string, ok: boolean, detail = "") => report(name, ok, ok ? "" : detail);

// (The harness runs from harness/.out.)
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const assets = path.join(app, "dist/assets");

// ------------------------------------------------------------- the config

{
  const config = readFileSync(path.join(app, "vite.config.ts"), "utf8");
  check("the build is told its floor is Safari 15", /target:\s*\[[^\]]*"safari15"[^\]]*\]/.test(config));
  const loader = readFileSync(path.join(app, "src/lib/pdfjs.ts"), "utf8");
  check("the PDF reader's worker goes through the build, not in as a file", /pdf\.worker\.min\.mjs\?worker/.test(loader) && !/pdf\.worker[^"']*\?url/.test(loader));
  check("…and a webview that cannot run the reader gets one plain error", /throw PDF_UNAVAILABLE/.test(loader));
  const users = ["src/apps/documents/import", "src/apps/canvas", "src/pdf"].flatMap((dir) => {
    const root = path.join(app, dir);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const file = path.join(d, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (/\.tsx?$/.test(name) && /from "pdfjs-dist|import\("pdfjs-dist/.test(readFileSync(file, "utf8").replace(/import type [^;]+;/g, ""))) out.push(path.relative(app, file));
      }
    };
    walk(root);
    return out;
  });
  check("nothing in the app loads the PDF reader except through that one loader", users.length === 0, users.join(", "));
}

// ------------------------------------------------------------ what was built

if (!existsSync(assets)) {
  check("(not built: run `npm run build` and this reads what it made)", true);
} else {
  const files = readdirSync(assets).filter((name) => /\.(js|mjs)$/.test(name));
  check("(the build's scripts are there to read)", files.length > 0, String(files.length));

  /** A look-behind that a library first makes sure the engine has, inside
   *  a `try`. Never run where it is not understood, and never parsed as a
   *  pattern (it is a string until then). `marked` does this. */
  const GUARDED = [
    /try\{return!!new RegExp\("\(\?<=1\)\(\?<!1\)"/,
    /\?"\(\?<!`\)\(\)":"\(\^\^\|\[\^`\]\)"/,
  ];
  const blocks: string[] = [];
  const behind: string[] = [];
  for (const name of files) {
    const code = readFileSync(path.join(assets, name), "utf8");
    // Minified: `static{`. Not minified (a worker file passed through): `static {`.
    if (/\bstatic\s*\{/.test(code)) blocks.push(name);
    const pattern = /\(\?<[=!]/g;
    for (let m = pattern.exec(code); m; m = pattern.exec(code)) {
      const around = code.slice(Math.max(0, m.index - 40), m.index + 40);
      if (!GUARDED.some((re) => re.test(around))) behind.push(`${name}: …${around.replace(/\s+/g, " ")}…`);
    }
  }
  check("no built script holds a class static block (Safari 15 cannot read the file)", blocks.length === 0, blocks.join(", "));
  check("no built script holds a look-behind that is not first tested for", behind.length === 0, `\n  ${behind.slice(0, 6).join("\n  ")}`);
  check("the PDF reader's worker was built (it is one of the scripts)", files.some((name) => /pdf\.worker/.test(name)), files.filter((n) => /pdf/.test(n)).join(", "));
}

finish();
