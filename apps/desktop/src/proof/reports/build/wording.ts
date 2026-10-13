import { hasCapital, matchCase } from "../../engine/casing";
import type { BlockFacts } from "../../engine/facts";
import { scopeBlocks, scopeRoll, type StyleAnalysis } from "../analysis";
import type { Hit, HitGroup, HitItem, Measure, ReportResult, Scope } from "../types";
import { wordingOf, WORDING_GROUPS, type WordingGroup, type WordingHit } from "../wording";

const num = (n: number): string => Math.round(n).toLocaleString("en-US");
const one = (n: number): string => (Math.round(n * 10) / 10).toLocaleString("en-US");
const WORDING = "$wording";
const MOST = 120;
const HITS_MOST = 400;

const GROUPS: Record<WordingGroup, { label: string; hint: string }> = {
  passive: { label: "Likely passive verbs", hint: "A form of to be and a past participle (was taken). Some only describe (the door was closed) and are fine." },
  adverbs: { label: "Words in -ly", hint: "Adverbs, listed by word. One on a strong verb is often not needed." },
  filter: { label: "Filter words", hint: "She saw, he felt, they noticed. The reader watches the character and not the thing. Not looked for in speech." },
  feelings: { label: "Feelings told", hint: "Felt angry, a wave of relief. Named and not shown." },
  padding: { label: "Padding words", hint: "Very, really, just. Fix takes one out where the sentence stands without it." },
  cliches: { label: "Worn phrases", hint: "Phrases met so often that they pass unseen." },
  redundant: { label: "Words that say it twice", hint: "Nodded his head, stood up, past history. Fix leaves the one word that says it." },
  wordy: { label: "Wordy phrases", hint: "Several words where one or two would do." },
  confused: { label: "Easily confused words", hint: "Each of these is a word, so nothing flags a wrong one. Every use is listed for you to look at." },
};

/** What the report finds in a block, made once for its text. */
function hitsOf(a: StyleAnalysis, facts: BlockFacts[], block: number): WordingHit[] {
  const had = facts[block].per.get(WORDING);
  if (had) return had.note as WordingHit[];
  const made = a.english ? wordingOf(a.scan.blocks[block], facts[block]) : [];
  facts[block].per.set(WORDING, { stamp: "", note: made });
  return made;
}

/**
 * How the words are chosen. In fiction, speech is left out unless asked
 * for: people talk in worn phrases and padding, and that is character.
 * Filter words are never looked for in speech. `allowed` are words and
 * phrases the writer has said are fine.
 */
export function buildWording(a: StyleAnalysis, scope: Scope, allowed: Set<string>, withSpeech: boolean): ReportResult {
  const [from, to] = scopeBlocks(a, scope);
  const roll = scopeRoll(a, scope);
  const by = new Map<WordingGroup, Map<string, { hits: Hit[]; to?: string; advice?: string; maybe: number }>>();
  let passives = 0;
  if (a.facts.length) {
    for (let block = from; block < to; block += 1) {
      for (const hit of hitsOf(a, a.facts, block)) {
        if ((hit.spoken && !withSpeech) || allowed.has(hit.key)) continue;
        let group = by.get(hit.group);
        if (!group) by.set(hit.group, (group = new Map()));
        let item = group.get(hit.key);
        if (!item) group.set(hit.key, (item = { hits: [], maybe: 0 }));
        if (hit.group === "passive") passives += 1;
        if (hit.advice === "maybe") item.maybe += 1;
        else if (hit.advice) item.advice = hit.advice;
        if (hit.to !== undefined) item.to = hit.to;
        if (item.hits.length >= HITS_MOST) continue;
        // (Written in the capitals of what it replaces: "In order to" is "To".)
        const was = a.scan.blocks[block].text.slice(hit.start, hit.end);
        const fix = hit.to !== undefined ? [{ start: hit.start, end: hit.end, text: hasCapital(hit.to) ? hit.to : matchCase(was, hit.to).text }] : hit.cut ? [{ start: hit.cut[0], end: hit.cut[1], text: "" }] : undefined;
        item.hits.push({ block, start: hit.start, end: hit.end, ...(fix ? { fix } : {}) });
      }
    }
  }
  const groups: HitGroup[] = [];
  const counts: Partial<Record<WordingGroup, number>> = {};
  for (const id of WORDING_GROUPS) {
    const group = by.get(id);
    if (!group) continue;
    const items: HitItem[] = [...group]
      .map(([key, item]) => {
        const count = item.hits.length;
        const said = count === 1 ? "once" : count === 2 ? "twice" : `${num(count)} times`;
        const detail = item.to !== undefined ? `${said}. Write “${item.to}”.` : item.advice ? `${said}. Try ${item.advice}.` : said;
        return { key, label: key.split("{poss}").join("his or her"), detail, count, hits: item.hits, ...(item.to !== undefined ? { to: item.to } : {}) };
      })
      .sort((x, y) => y.count - x.count);
    const total = items.reduce((n, item) => n + item.count, 0);
    counts[id] = total;
    groups.push({ id, label: GROUPS[id].label, hint: GROUPS[id].hint, count: total, items: items.slice(0, MOST) });
  }
  const summary: Measure[] = [];
  const per = (n: number, each: number) => (roll.words ? (n / roll.words) * each : 0);
  if (roll.words) {
    summary.push({ id: "adverbs", label: "Words in -ly", value: per(counts.adverbs ?? 0, 1000), text: `${one(per(counts.adverbs ?? 0, 1000))} in every 1,000 words` });
    summary.push({ id: "passive", label: "Likely passives", value: roll.sentences ? (passives / roll.sentences) * 100 : 0, text: `${one(roll.sentences ? (passives / roll.sentences) * 100 : 0)} in every 100 sentences` });
    summary.push({ id: "filter", label: "Filter words", value: per(counts.filter ?? 0, 1000), text: `${one(per(counts.filter ?? 0, 1000))} in every 1,000 words` });
  }
  const found = groups.reduce((n, g) => n + g.count, 0);
  const notes = ["These are counts of likely things, told from the words alone. Each is for you to judge."];
  if (a.fiction && !withSpeech) notes.push("Speech is left out. People talk as they talk.");
  if (!a.english) notes.push("This report reads English only.");
  return { id: "wording", headline: !a.english ? "This report reads English only." : found ? `${num(found)} places to look at in ${num(groups.length)} kinds.` : "Nothing remarked on.", summary, series: [], groups, notes };
}
