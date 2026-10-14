#!/usr/bin/env node
// Build the PDF engine (pdf-engine/) to WebAssembly and put the result where
// the app loads it from (src/pdf/engine/pkg). The result is committed, so
// only whoever changes the engine runs this:
//
//   node tools/build-pdf-engine.mjs
//
// It needs, beside the Rust the repository pins (with its wasm32 target,
// which pdf-engine/rust-toolchain.toml asks for):
//   - wasm-bindgen, the very version the engine's own crate is built with
//     (cargo install wasm-bindgen-cli --version <BINDGEN> --locked)
//   - wasm-opt, from binaryen (brew install binaryen)
//
// Three steps. cargo builds the engine small. wasm-bindgen makes the
// JavaScript that calls it. wasm-opt makes it smaller still, and is told
// which WebAssembly features the oldest webview the app supports has
// (Safari 15): a build that needs any other fails here, not in someone's
// hands.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENGINE_DIR, engineSourceHash, PKG_DIR } from "./pdf-engine-hash.mjs";

/** The wasm-bindgen this is built with (pdf-engine/crates/wasm/Cargo.toml pins the same). */
const BINDGEN = "0.2.129";
/** The most the built engine may weigh. */
const BUDGET_BYTES = 4_000_000;
/** What Safari 15 can run. */
const FEATURES = ["mutable-globals", "sign-ext", "multivalue", "bulk-memory", "bulk-memory-opt", "nontrapping-float-to-int", "reference-types"];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
const need = (cmd, args, how, opts = {}) => {
  try {
    return run(cmd, args, opts).trim();
  } catch {
    console.error(`${cmd} is not installed. ${how}`);
    process.exit(1);
  }
};

const bindgen = need("wasm-bindgen", ["--version"], `Install it with: cargo install wasm-bindgen-cli --version ${BINDGEN} --locked`);
if (!bindgen.endsWith(` ${BINDGEN}`)) {
  console.error(`wasm-bindgen ${BINDGEN} is needed, and this is ${bindgen}. Install it with: cargo install wasm-bindgen-cli --version ${BINDGEN} --locked`);
  process.exit(1);
}
const wasmOpt = need("wasm-opt", ["--version"], "Install binaryen (brew install binaryen).");
const rustc = need("rustc", ["--version"], "Install Rust (rustup).", { cwd: ENGINE_DIR });

console.log("Building the engine…");
execFileSync("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown", "-p", "wfpdf-wasm"], { cwd: ENGINE_DIR, stdio: "inherit" });
const built = join(ENGINE_DIR, "target/wasm32-unknown-unknown/release/wfpdf_wasm.wasm");

const work = mkdtempSync(join(tmpdir(), "wfpdf-"));
try {
  run("wasm-bindgen", ["--target", "web", "--out-dir", work, "--out-name", "wfpdf", built]);
  const raw = join(work, "wfpdf_bg.wasm");
  const small = join(work, "wfpdf_small.wasm");
  // (Only these features are allowed: wasm-opt refuses a module that uses another.)
  run("wasm-opt", ["-Os", "--mvp-features", ...FEATURES.map((f) => `--enable-${f}`), raw, "-o", small]);

  const bytes = statSync(small).size;
  if (bytes > BUDGET_BYTES) {
    console.error(`The engine is ${bytes} bytes, over the ${BUDGET_BYTES} it may be.`);
    process.exit(1);
  }
  rmSync(PKG_DIR, { recursive: true, force: true });
  mkdirSync(PKG_DIR, { recursive: true });
  copyFileSync(small, join(PKG_DIR, "wfpdf_bg.wasm"));
  copyFileSync(join(work, "wfpdf.js"), join(PKG_DIR, "wfpdf.js"));
  copyFileSync(join(work, "wfpdf.d.ts"), join(PKG_DIR, "wfpdf.d.ts"));
  const stamp = {
    // What it was built from (tools/pdf-engine-hash.mjs). A harness fails when the source has moved on.
    source: engineSourceHash(),
    bytes,
    rustc: rustc.replace(/^rustc\s+/, "").split(" ")[0],
    wasmBindgen: BINDGEN,
    wasmOpt: wasmOpt.replace(/^wasm-opt version\s+/, "").split(" ")[0],
    features: FEATURES,
  };
  writeFileSync(join(PKG_DIR, "BUILD.json"), `${JSON.stringify(stamp, null, 2)}\n`);
  const packed = readFileSync(join(PKG_DIR, "wfpdf_bg.wasm")).length;
  console.log(`Done: ${(packed / 1_000_000).toFixed(2)} MB in src/pdf/engine/pkg`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
