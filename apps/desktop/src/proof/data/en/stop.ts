// The small words of English: left out when counting the words a writer
// leans on, and never a "repeat". Written for this app.

export const ARTICLES = new Set("a an the".split(" "));
export const CONJUNCTIONS = new Set("and or but nor so yet for".split(" "));
export const PREPOSITIONS = new Set(
  "of to in on at by for with from into onto over under about after before between through during without within against toward towards upon as than like near off out up down across along around behind beside beyond inside outside past since until".split(" "),
);
export const AUXILIARIES = new Set(
  "is are was were be been being am has have had having do does did will would can could shall should may might must isn't aren't wasn't weren't hasn't haven't hadn't don't doesn't didn't won't wouldn't can't couldn't shouldn't".split(" "),
);

export const STOP_WORDS = new Set([
  ...ARTICLES,
  ...CONJUNCTIONS,
  ...PREPOSITIONS,
  ...AUXILIARIES,
  ...(
    "i me my mine myself you your yours yourself he him his himself she her hers herself it its itself we us our ours ourselves they them their theirs themselves " +
    "this that these those there here who whom whose which what when where why how " +
    "not no nor yes if then else because while although though unless whether either neither both each every all any some none one two three four five six seven eight nine ten " +
    "more most much many few less least other another such same own very too just only also even still again ever never always often once now soon already almost quite rather " +
    "i'm i've i'd i'll you're you've you'd you'll he's he'd he'll she's she'd she'll it's it'd it'll we're we've we'd we'll they're they've they'd they'll that's there's here's what's who's let's " +
    "said say says asked ask asks get got gets getting go goes went gone going come came comes coming make made makes making take took taken takes know knew known see saw seen " +
    "thing things something anything nothing everything someone anyone everyone nobody somebody anybody everybody mr mrs ms dr"
  ).split(" "),
]);
