// Verb forms the Word choice report tells a passive by. Written for this app.

export const BE_FORMS = new Set("am is are was were be been being isn't aren't wasn't weren't i'm you're we're they're".split(" "));

/** Words that may stand between "was" and the verb. */
export const BETWEEN = new Set("not never also always often still just already soon quickly slowly quietly finally suddenly really very quite almost nearly barely hardly simply only ever again".split(" "));

/** Past participles that do not end in -ed, of verbs that take an object. */
export const IRREGULAR_PARTICIPLES = new Set(
  (
    "taken given made done seen known shown told sold held kept left lost found built bought brought caught taught thought sought fought written driven eaten beaten bitten broken chosen forgotten forgiven frozen hidden ridden risen shaken spoken stolen sworn torn worn woven " +
    "drawn thrown blown grown flown begun drunk sung rung sunk swum hung stuck struck stung swung dug fed led read said paid laid sent spent lent bent built burnt dealt felt heard meant met put cut hit hurt set shut spread split let cast " +
    "bound wound ground found sold told won shot bred bled sped understood overcome undone withdrawn withheld mistaken forbidden forsaken overtaken undertaken rewritten outdone overthrown"
  ).split(" "),
);

/** Words in -ed that are not verbs. */
export const ED_NOT_VERBS = new Set(
  "hundred naked wicked sacred beloved rugged ragged jagged crooked wretched aged learned blessed cursed dogged kindred hatred shed sped bled bred fled sled bed red wed fed led need indeed speed seed weed deed feed greed breed bleed exceed proceed succeed agreed freed".split(
    " ",
  ),
);

/** Words in -ed that describe a state more often than tell of an action:
 *  "was tired" is no passive, "was tired by the climb" is. */
export const STATE_WORDS = new Set(
  (
    "tired excited interested married scared surprised supposed used dressed lost worried pleased bored annoyed confused embarrassed frightened amazed disappointed satisfied relieved concerned determined convinced prepared delighted depressed exhausted shocked thrilled " +
    "ashamed alarmed amused astonished pleased terrified puzzled stunned inclined accustomed committed dedicated devoted engaged involved located situated related connected qualified experienced educated advanced crowded deserted isolated complicated sophisticated " +
    "gone done finished closed opened drunk broken"
  ).split(" "),
);
