// A deterministic synthetic manuscript: enough prose, and one of every
// element a book can hold, to exercise layout without shipping a novel.

export type N = { type: string; attrs?: Record<string, unknown>; content?: N[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };

/** mulberry32: the same sequence on every run and every machine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "the of and a to in is that it was for on are as with his they at be this from have or one had by word but not what all were we when " +
  "your can said there use an each which she do how their if will up other about out many then them these so some her would make like " +
  "him into time has look two more write go see number no way could people my than first water been call who oil its now find long down " +
  "day did get come made may part over river window morning silence letter garden winter harbour station lantern whisper shoulder evening " +
  "remember beneath against between although perhaps suddenly afterwards neighbourhood understanding extraordinary conversation " +
  "circumstances nevertheless acquaintance disappointment considerable particularly immediately possibility"
).split(" ");
const NAMES = ["Marianne", "Thaddeus", "Ophelia", "Bartholomew", "Cecily", "Mr. Ashworth", "Mrs. Penhallow"];

export function manuscript(opts: { chapters?: number; seed?: number } = {}): N {
  const rand = prng(opts.seed ?? 20261010);
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const sentence = () => {
    const n = 6 + Math.floor(rand() * 14);
    const words = Array.from({ length: n }, (_, i) => (i > 0 && rand() < 0.06 ? pick(NAMES) : pick(WORDS)));
    const s = words.join(" ");
    return s[0].toUpperCase() + s.slice(1) + (rand() < 0.1 ? "?" : ".");
  };
  const prose = (min = 2, max = 7) =>
    Array.from({ length: min + Math.floor(rand() * (max - min + 1)) }, sentence).join(" ");
  const text = (t: string, ...marks: string[]): N => ({ type: "text", text: t, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
  const p = (content: N[] | string, attrs: Record<string, unknown> = {}): N => ({
    type: "paragraph",
    attrs,
    content: typeof content === "string" ? [text(content)] : content,
  });
  const dialogue = () => p([text("“" + sentence() + "” said " + pick(NAMES) + ". “"), text(sentence().replace(/\.$/, ""), "italic"), text(",” came the answer.")]);

  const content: N[] = [];
  content.push(p("Prologue", { element: "section_heading" }));
  content.push(p(prose(4, 6)), p(prose()), p(prose()));
  const chapters = opts.chapters ?? 14;
  for (let c = 1; c <= chapters; c += 1) {
    if (c === 1) content.push(p("The Harbour", { element: "part_heading" }));
    if (c === Math.ceil(chapters / 2) + 1) content.push(p("The Garden", { element: "part_heading" }));
    content.push(p(c % 3 === 0 ? `Chapter ${c}` : `A ${pick(WORDS)} ${pick(WORDS)}`, { element: "chapter_heading" }));
    if (c === 2) content.push(p("In which a letter arrives", { element: "chapter_subtitle" }));
    if (c === 3) {
      content.push(p(sentence(), { element: "epigraph" }), p("An Old Song", { element: "attribution" }));
    }
    const paragraphs = 14 + Math.floor(rand() * 10);
    for (let i = 0; i < paragraphs; i += 1) {
      const r = rand();
      if (r < 0.2) content.push(dialogue());
      else if (r < 0.24 && i > 2) content.push({ type: "horizontalRule" });
      else if (r < 0.27) content.push({ type: "blockquote", content: [p("Dear " + pick(NAMES) + ","), p(prose(2, 4)), p("Yours, " + pick(NAMES), { align: "right" })] });
      else if (r < 0.29) content.push({ type: "paragraph", attrs: { element: "verse" }, content: [text(sentence()), { type: "hardBreak" }, text(sentence()), { type: "hardBreak" }, text(sentence())] });
      else if (r < 0.31) content.push(p("A " + pick(WORDS) + " interlude", { element: "subheading" }));
      else if (r < 0.33) content.push(p(sentence(), { align: "center" }));
      else if (r < 0.345) content.push(p(prose(), { pageBreakBefore: true }));
      else if (r < 0.36) content.push({ type: "bulletList", content: [1, 2, 3].map(() => ({ type: "listItem", content: [p(sentence())] })) });
      else content.push(p([text(prose(1, 3) + " "), text(pick(WORDS), "bold"), text(" " + prose(1, 4))]));
    }
  }
  content.push(p("Acknowledgments", { element: "section_heading" }));
  content.push(p(prose(3, 5)));
  return { type: "doc", content };
}
