// Written for this app.

/** Pairs that are right as they stand ("she had had enough"), or that are
 *  one word said twice on purpose. Never reported. */
export const LEGIT_DOUBLES = new Set(
  (
    "had that " +
    "bye night there now hush chop tut ha ho hee heh knock bang boo blah yada win pom tom cha so no yes yeah oh ah very really far long many more never again please wait go come run stop look well okay ok hey hi my dear"
  ).split(" "),
);

/** Small words that nobody says twice on purpose. Inside speech these are
 *  the only doubles reported (people do say "no, no" and "very very"). */
export const SMALL_WORDS = new Set(
  (
    "the a an of to in and on at for with is it as by or be was are this from but not his her their its our your he she we they you who which when if into than then were been has have will would can could should " +
    "these those about after before over under through between out up down off"
  ).split(" "),
);
