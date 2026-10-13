// How a sentence can begin, told from its first word alone. Closed lists,
// written for this app. A word in none of them is "something else".

export const OPEN_PRONOUNS = new Set("i he she it they we you his her their my our your its".split(" "));
export const OPEN_DETERMINERS = new Set("the a an this that these those some every each no all both many most several one two three another any".split(" "));
/** Words that tie a sentence to the one before. */
export const OPEN_LINKS = new Set(
  "and but so then or nor yet however still meanwhile instead besides also thus therefore moreover furthermore nevertheless nonetheless otherwise finally next later afterwards afterward soon eventually suddenly anyway indeed".split(" "),
);
/** Words that open with a setting or a condition before the main clause. */
export const OPEN_LEADS = new Set(
  "when as after before while if because since although though once until unless whenever wherever in on at by with from for to under over through during without behind beside across inside outside despite upon among between near like beyond above below".split(
    " ",
  ),
);
/** Words ending -ing that are things and not actions. */
export const ING_NOUNS = new Set("morning evening nothing something anything everything king ring thing spring string wing ceiling building feeling meaning wedding darling sibling".split(" "));
/** Words ending -ly that do not say how a thing was done. */
export const LY_OTHERS = new Set("only early family reply supply apply july italy belly bully fly rely ally lily holy ugly silly lonely lovely friendly likely elderly daily".split(" "));
