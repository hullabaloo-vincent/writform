/**
 * What is known about one block from its own text: its tokens, its quote
 * marks, where its sentences begin, and whatever each check noted in it.
 * Nothing here knows where the block is in the document, so it stays good
 * while the text above it changes, and when every node is made anew (an
 * undo, a co-writer's change).
 */

import type { BlockInput, Env } from "../types";
import { flagSpeech, readQuotes, type QuoteFacts } from "./quotes";
import { markSentences } from "./sentences";
import { countWords, tokenize, type Tokens } from "./tokens";

export interface BlockFacts {
  tokens: Tokens;
  quotes: QuoteFacts;
  /** The tokens that open a sentence. */
  starts: number[];
  words: number;
  /** Each check's own notes, by its id, and the stamp they were made under. */
  per: Map<string, { stamp: string; note: unknown }>;
  /** The reading that last used it. */
  seen: number;
}

export function readBlock(block: BlockInput, env: Env): BlockFacts {
  const tokens = tokenize(block.text);
  const quotes = readQuotes(block.text, env.quotes, env.base === "en");
  flagSpeech(block.text, tokens, quotes);
  const starts = markSentences(block.text, tokens, quotes);
  return { tokens, quotes, starts, words: countWords(tokens), per: new Map(), seen: 0 };
}
