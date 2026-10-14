// One number for the PDF engine's source (pdf-engine/), so the committed
// build can say what it was built from and a check can tell when it no
// longer is. Shared by the build tool and by harness/pdfengine.test.ts.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The engine's folder, from this file. */
export const ENGINE_DIR = join(here, "../../../pdf-engine");
/** Where its build is kept, for the app to load. */
export const PKG_DIR = join(here, "../src/pdf/engine/pkg");

/** Every file of the engine's source, in a fixed order (what a build makes
 *  for itself is left out). */
function sourceFiles(dir, root = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "target" || name === ".DS_Store") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, root, out);
    else out.push(relative(root, path).split(sep).join("/"));
  }
  return out;
}

/** A hash of the engine's source: its files' names and what is in them. */
export function engineSourceHash(dir = ENGINE_DIR) {
  const hash = createHash("sha256");
  for (const file of sourceFiles(dir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
