// Headless regression harnesses for logic the app can't be asked to prove
// by clicking: the document schema gate, sync, converters, layout. Each
// `*.test.ts` here is bundled with esbuild and run in Node; it prints
// PASS/FAIL lines and exits non-zero on a failure.
//
//   npm run harness            every harness
//   npm run harness -- schema  those whose file name starts with "schema"
//
// Outside `src`, so tsc, eslint and the app bundle never see these files.

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, ".out");
const wanted = process.argv.slice(2);
const tests = readdirSync(here)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)))
  .sort();
if (tests.length === 0) {
  console.error(`No harness matches ${wanted.join(", ")}`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });

// What Vite does for the app, done for Node: `?url` imports become file
// URLs (the env shim's fetch reads them), fontkit's brotli is stubbed as in
// vite.config.ts, and styles and font binaries are dropped.
const assets = {
  name: "assets",
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?url$/, "")),
      namespace: "file-url",
    }));
    b.onLoad({ filter: /.*/, namespace: "file-url" }, (args) => ({
      contents: `export default ${JSON.stringify(`file://${args.path}`)};`,
      loader: "js",
    }));
    b.onResolve({ filter: /^brotli(\/.*)?$/ }, () => ({
      path: path.join(here, "../src/book/engine/brotliStub.ts"),
    }));
  },
};

let failed = 0;
for (const test of tests) {
  const outfile = path.join(out, test.replace(/\.ts$/, ".mjs"));
  await build({
    entryPoints: [path.join(here, test)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    loader: { ".css": "empty", ".ttf": "empty", ".otf": "empty" },
    define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true }) },
    plugins: [assets],
    // jsdom reads its own files at runtime and pdf.js loads its worker from
    // beside itself, so Node loads those two, not the bundle. (TypeScript's
    // compiler, which one harness reads the source with, is simply large.)
    external: ["jsdom", "pdfjs-dist", "typescript"],
    // CommonJS dependencies call require().
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "warning",
  });
  console.log(`\n── ${test}`);
  const run = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
  if (run.status !== 0) failed += 1;
}
console.log(failed ? `\n${failed} of ${tests.length} harnesses FAILED` : `\nAll ${tests.length} harnesses passed`);
process.exit(failed ? 1 : 0);
