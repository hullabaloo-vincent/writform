import type { BlockFacts } from "../../engine/facts";
import { scopeBlocks, scopeRoll, type StyleAnalysis } from "../analysis";
import { dialogueOf, type DialogueFacts, type Tag } from "../dialogue";
import type { Hit, HitGroup, HitItem, Measure, ReportResult, Scope, Series } from "../types";

const num = (n: number): string => Math.round(n).toLocaleString("en-US");
const DIALOGUE = "$dialogue";
/** Speech paragraphs in a row with no tag before the reader may lose who speaks. */
const UNTAGGED = 6;

const SLIPS: Record<NonNullable<Tag["slip"]>["what"], { label: string; detail: string }> = {
  action: { label: "An action used as a tag", detail: "“Go,” she smiled. Nobody smiles a word. Fix makes it a sentence of its own." },
  stop: { label: "A full stop before the tag", detail: "“Go.” she said. Fix makes it a comma." },
  capital: { label: "A capital on the tag", detail: "“Go,” She said. Fix makes it lowercase." },
  bare: { label: "No comma before the closing mark", detail: "“Go” she said. Fix puts one in." },
};

function tagsOf(a: StyleAnalysis, facts: BlockFacts[], block: number): DialogueFacts {
  const had = facts[block].per.get(DIALOGUE);
  if (had) return had.note as DialogueFacts;
  const made = a.english ? dialogueOf(a.scan.blocks[block], facts[block]) : { tags: [], bare: false };
  facts[block].per.set(DIALOGUE, { stamp: "", note: made });
  return made;
}

/**
 * Speech and its tags: how much of the text is speech, which verbs carry
 * it, tags with an -ly word, punctuation amiss between speech and tag, and
 * long exchanges where nobody is named.
 */
export function buildDialogue(a: StyleAnalysis, scope: Scope): ReportResult {
  const [from, to] = scopeBlocks(a, scope);
  const roll = scopeRoll(a, scope);
  const verbs = new Map<string, Hit[]>();
  const actions = new Map<string, Hit[]>();
  const adverbs = new Map<string, Hit[]>();
  const slips = new Map<string, Hit[]>();
  const untagged: HitItem[] = [];
  const push = (map: Map<string, Hit[]>, key: string, hit: Hit) => {
    const list = map.get(key);
    if (list) list.push(hit);
    else map.set(key, [hit]);
  };
  let plain = 0;
  let other = 0;
  let acted = 0;
  let run: number[] = [];
  const endRun = () => {
    if (run.length >= UNTAGGED) {
      untagged.push({ key: "", label: `${run.length} paragraphs of speech with no tag`, count: run.length, hits: run.map((block) => ({ block, start: a.style[block].at[0] ?? 0, end: a.style[block].end[0] ?? 0 })) });
    }
    run = [];
  };
  if (a.facts.length) {
    for (let block = from; block < to; block += 1) {
      if (a.style[block].kind !== 2 || a.style[block].n === 0) {
        if (a.style[block].kind !== 2) endRun();
        continue;
      }
      const d = tagsOf(a, a.facts, block);
      if (d.bare) run.push(block);
      else endRun();
      for (const tag of d.tags) {
        const hit: Hit = { block, start: tag.start, end: tag.end };
        if (tag.kind === "plain") plain += 1;
        else if (tag.kind === "speech") {
          other += 1;
          push(verbs, tag.verb, hit);
        } else {
          acted += 1;
          push(actions, tag.verb, hit);
        }
        if (tag.adverb) push(adverbs, tag.adverb[2], { block, start: tag.adverb[0], end: tag.adverb[1] });
        if (tag.slip) push(slips, tag.slip.what, { block, start: tag.slip.start, end: tag.slip.end, ...(tag.slip.fix ? { fix: tag.slip.fix } : {}) });
      }
    }
    endRun();
  }
  const items = (map: Map<string, Hit[]>): HitItem[] => [...map].map(([key, hits]) => ({ key: "", label: key, detail: hits.length === 1 ? "once" : `${num(hits.length)} times`, count: hits.length, hits })).sort((x, y) => y.count - x.count);
  const groups: HitGroup[] = [];
  const add = (id: string, label: string, hint: string, list: HitItem[]) => {
    if (list.length) groups.push({ id, label, hint, count: list.reduce((n, item) => n + item.count, 0), items: list });
  };
  add(
    "slips",
    "Punctuation between speech and tag",
    "Where the mark before the closing quote and the word after it do not go together.",
    [...slips].map(([what, hits]) => ({ key: "", label: SLIPS[what as keyof typeof SLIPS].label, detail: SLIPS[what as keyof typeof SLIPS].detail, count: hits.length, hits })),
  );
  add("verbs", "Tags other than said and asked", "Listed by verb. Said and asked are the tags the eye passes over.", items(verbs));
  add("actions", "Actions used as tags", "Smiled, nodded, shrugged, where the tag should say who spoke.", items(actions));
  add("adverbs", "Tags with a word in -ly", "Said softly, asked angrily. The speech itself can often carry it.", items(adverbs));
  add("untagged", "Long exchanges with no tag", `${UNTAGGED} or more paragraphs of speech in a row with nobody named.`, untagged);

  const tags = plain + other + acted;
  const summary: Measure[] = [];
  if (roll.words) summary.push({ id: "speech", label: "Inside quote marks", value: roll.speech / roll.words, text: `${Math.round((roll.speech / roll.words) * 100)}%` });
  if (tags) summary.push({ id: "tags", label: "Tags", value: tags, text: num(tags) });
  const series: Series[] = tags ? [{ id: "tags", kind: "bars", label: "The verbs that carry the speech", values: [plain, other, acted], labels: ["Said and asked", "Other verbs of speech", "Actions"] }] : [];
  const notes = a.english ? ["A sentence of its own after speech (“Go.” She smiled.) is a beat and not a tag. It is never counted or changed."] : ["This report reads English only."];
  return { id: "dialogue", headline: !a.english ? "This report reads English only." : tags ? `${num(tags)} tags. ${num(plain)} are said or asked.` : "No tagged speech found.", summary, series, groups, notes };
}
