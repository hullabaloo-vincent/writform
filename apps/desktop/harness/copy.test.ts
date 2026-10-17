// The house style for anything a person reads: no em dashes and no
// semicolons — in the app's own wording (labels, hints, tooltips, messages)
// and in the public docs, and American spelling (color, center, gray,
// license). (The third rule, no "phrase, punchy fragment"
// taglines, needs a reader; this catches what a machine can.)
//
// Comments are not checked, nor is what belongs to a writer's document
// rather than to the app (an epigraph's attribution dash, what smart
// punctuation types, the symbol palette).

import { check as report, finish } from "./env";

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** (What was found is only worth printing when something was.) */
const check = (name: string, ok: boolean, detail = "") => report(name, ok, ok ? "" : detail);

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../..");
const repo = path.resolve(app, "../..");

// ------------------------------------------------------------ the app's wording

/** Files whose strings are document content, data or code — not wording. */
const NOT_WORDING = [
  /src\/lib\/devPreview\.ts$/, // the development stand-in for a server
  /src\/bindings\//,
  /src\/editor\/ui\/symbols\.ts$/, // the symbol palette: the characters themselves
  /src\/editor\/SmartPunctuation\.ts$/, // what "--" turns into
  /src\/book\/model\/punctuation\.ts$/,
  /src\/book\/model\/chapters\.ts$/, // a pattern that reads headings
  /src\/book\/epub\/epub\.ts$/, // the ebook's own stylesheet and pages
  /src\/book\/smf\/docx\.ts$/, // the manuscript file's own text
  /src\/proof\/data\//, // the checker's word lists: words to find, not words shown
  /src\/editor\/autocorrect\/data\//, // what is typed and what it becomes: not words shown
];
/** British spellings. The app speaks American English: color, center,
 *  gray, license, canceled. Whole words only. */
const BRITISH =
  /\b(colours?|coloured|colouring|centres?|centred|centring|grey|greys|greyed|licences?|cancelled|cancelling|customis\w*|organis\w*|recognis\w*|favourit\w*|behaviours?|honour|honoured|neighbours?|judgement|catalogues?|analys(?:e|ed|es|ing)|realis(?:e|ed|es|ing|ation)|summaris\w*|apologis\w*|prioritis\w*|categoris\w*|visualis\w*|synchronis\w*|authoris\w*|standardis\w*|utilis\w*|memoris\w*|minimis\w*|maximis\w*|optimis\w*|normalis\w*|initialis\w*|finalis\w*|labelled|labelling|modelled|modelling|travelled|travelling|signalled|levelled|programmes?|theatres?|defence|offence|whilst|amongst|humour|flavour|armour|rumour|practise|ageing|enrol|fulfil)\b/i;
/** Where a British spelling is meant: a font licence's own name, a code or
 *  a class name (no spaces, lower case), and Check's examples of what it finds. */
const BRITISH_NAMES = /Ubuntu Font Licence/g;
const CODE = /^[a-z0-9_.\/-]+$/;
const BRITISH_FILES = [/src\/proof\/checks\/spelling\.ts$/, /src\/proof\/reports\/build\/pace\.ts$/];
/** Lines of the docs that show British spelling on purpose (what Check finds). */
const BRITISH_EXAMPLES = [/"licence" and "organisation"/, /\(color, colour\)/, /\(judgement, judgment\)/, /\(colour and color/];
const britishIn = (text: string): string | null => {
  const plain = text.replace(BRITISH_NAMES, "");
  return CODE.test(plain.trim()) ? null : (BRITISH.exec(plain)?.[0] ?? null);
};

/** A string that is plainly not a sentence shown to anyone. */
const notProse = (text: string): boolean =>
  /^\s*\[[a-z ]+\]/.test(text) || // a console line: "[typesetter] …"
  /[{}=<>]|&[a-z]+;|px\b|rgba?\(|var\(--|;\s*[a-z-]+\s*:/.test(text) || // markup, CSS ("…; margin: …"), entities
  text.trim().length <= 2; // a lone glyph drawn as a picture (a line's end on a board)

const found: string[] = [];
const british: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") && !NOT_WORDING.some((re) => re.test(file))) scan(file);
  }
};
function scan(file: string) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    const text =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)
        ? node.text
        : node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail
          ? (node as ts.TemplateLiteralLikeNode).text
          : null;
    if (text !== null && !notProse(text)) {
      const dash = text.includes("—");
      // A semicolon between words (not one that ends a line of code in a string).
      const semi = /[A-Za-z’'")…]\s*;\s*[A-Za-z“"(]/.test(text) || /^\s*;\s*[a-z]/.test(text) || /[a-z]\s*;\s*$/.test(text);
      if (dash || semi) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${path.relative(app, file)}:${line + 1}  ${dash ? "em dash" : "semicolon"}  ${text.replace(/\s+/g, " ").trim().slice(0, 90)}`);
      }
    }
    const spelled = text !== null && !BRITISH_FILES.some((re) => re.test(file)) ? britishIn(text) : null;
    if (spelled) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      british.push(`${path.relative(app, file)}:${line + 1}  ${spelled}  ${text!.replace(/\s+/g, " ").trim().slice(0, 90)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
walk(path.join(app, "src"));
// (The attribution dash a manuscript draws before an epigraph's author is
// the book's typography, set in two places of the layout.)
const wording = found.filter((line) => !/src\/book\/engine\/(layout|compose)\.ts:\d+ {2}em dash {2}—\s*$/.test(line));
check("nothing the app says has an em dash or a semicolon in it", wording.length === 0, `\n  ${wording.join("\n  ")}`);
check("what the app says is spelled the American way", british.length === 0, `\n  ${british.join("\n  ")}`);

// ------------------------------------------------------------ the public docs

const docs = [...readdirSync(path.join(repo, "docs-site/docs")).filter((f) => f.endsWith(".md")).map((f) => path.join(repo, "docs-site/docs", f)), path.join(repo, "README.md")];
for (const file of docs) {
  // Code keeps its own punctuation: fenced blocks and `spans` aren't prose.
  const prose = readFileSync(file, "utf8")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const lines = prose.split("\n");
  const bad = lines.flatMap((line, i) => (line.includes("—") || line.includes(";") ? [`${i + 1}: ${line.trim().slice(0, 90)}`] : []));
  check(`${path.relative(repo, file)}: no em dashes or semicolons in its prose`, bad.length === 0, `\n  ${bad.join("\n  ")}`);
  const spelled = lines.flatMap((line, i) => {
    const word = BRITISH_EXAMPLES.some((re) => re.test(line)) ? null : britishIn(line);
    return word ? [`${i + 1}: ${word}  ${line.trim().slice(0, 90)}`] : [];
  });
  check(`${path.relative(repo, file)}: spelled the American way`, spelled.length === 0, `\n  ${spelled.join("\n  ")}`);
}
{
  const manifest = JSON.parse(readFileSync(path.join(app, "public/manifest.webmanifest"), "utf8")) as { description?: string };
  check("the app's description (what a browser shows when it is installed) follows it too", !!manifest.description && !/[—;]/.test(manifest.description), manifest.description);
}

finish();
