// Words the Word choice report looks for. Written for this app.

/** Words in -ly that do not say how a thing was done. */
export const LY_EXCEPTIONS = new Set(
  (
    "only early family reply supply apply july italy belly bully fly rely ally lily holy ugly silly lonely lovely friendly likely elderly daily weekly monthly yearly hourly nightly " +
    "jelly rally assembly melancholy butterfly anomaly homily monopoly panoply wobbly bubbly curly burly surly early gangly ghastly ghostly godly goodly gnarly grisly gristly hilly homely kindly leisurely lively lordly lowly manly measly " +
    "orderly pearly prickly scholarly shapely sickly sly smelly sparkly spindly stately steely timely tingly ungainly unlikely unruly wily wobbly woolly worldly crumbly cuddly deadly costly cowardly brotherly sisterly motherly fatherly heavenly earthly " +
    "comply imply multiply ply underbelly dolly folly golly holly jolly molly polly trolley barely" +
    " billy lilly sally emily molly kelly holly carly beverly kimberly shelly willy tilly"
  ).split(" "),
);

/** Verbs that put a character between the reader and what happens. */
export const FILTER_ALWAYS = new Set("saw heard felt noticed watched sensed smelled smelt tasted realised realized wondered spotted glimpsed observed".split(" "));
/** …only when a clause follows ("she thought he lied", not "she thought about it"). */
export const FILTER_CLAUSE = new Set("thought knew decided understood remembered believed supposed".split(" "));
/** Who can do the filtering. */
export const PERSONS = new Set("i he she they we you".split(" "));
export const SUBJECT_PRONOUNS = new Set("i he she it they we you".split(" "));

export const LINKING = new Set("felt was were looked seemed grew became appeared sounded".split(" "));
export const INTENSIFIERS = new Set("very so really quite rather too extremely terribly incredibly utterly deeply a little bit somewhat".split(" "));
export const FEELING_ADJECTIVES = new Set(
  (
    "angry sad happy afraid scared frightened nervous anxious worried upset annoyed furious jealous lonely tired excited ashamed embarrassed guilty proud relieved surprised shocked confused frustrated disappointed bored curious hopeful hopeless helpless " +
    "miserable depressed delighted pleased grateful bitter resentful terrified horrified disgusted sick uneasy uncomfortable awkward calm content cheerful gloomy glad joyful sorrowful mournful desperate envious irritated impatient restless numb overwhelmed " +
    "exhausted elated ecstatic heartbroken homesick insecure intimidated vulnerable wary suspicious sympathetic tender tense thrilled touched troubled unhappy unsure"
  ).split(" "),
);
export const FEELING_NOUNS = new Set(
  (
    "anger sadness happiness fear dread panic terror horror anxiety worry jealousy loneliness excitement shame embarrassment guilt pride relief surprise shock confusion frustration disappointment boredom curiosity hope despair misery joy grief sorrow " +
    "rage fury envy resentment disgust nausea unease calm sympathy tenderness longing regret remorse happiness delight gratitude bitterness affection love hatred nostalgia"
  ).split(" "),
);
export const FEELING_WAVES = new Set("wave surge pang rush stab flash flicker twinge jolt flood".split(" "));

/** Words that add stress and no meaning. */
export const PADDING = new Set("very really just quite rather actually basically simply literally totally completely definitely certainly probably somewhat slightly".split(" "));

/** Sets of words taken for one another. Shown only when the text uses
 *  one of them, for the writer to look at each use. */
export const CONFUSED: string[][] = [
  ["affect", "effect"],
  ["discreet", "discrete"],
  ["principal", "principle"],
  ["complement", "compliment"],
  ["stationary", "stationery"],
  ["lose", "loose"],
  ["peak", "peek", "pique"],
  ["rein", "reign"],
  ["breath", "breathe"],
  ["passed", "past"],
  ["lead", "led"],
  ["bare", "bear"],
  ["brake", "break"],
  ["hoard", "horde"],
  ["palate", "palette", "pallet"],
  ["altar", "alter"],
  ["aisle", "isle"],
  ["cite", "site", "sight"],
  ["elicit", "illicit"],
  ["ensure", "insure"],
  ["flair", "flare"],
  ["forth", "fourth"],
  ["grisly", "grizzly"],
  ["lightening", "lightning"],
  ["moral", "morale"],
  ["pore", "pour"],
  ["precede", "proceed"],
  ["shear", "sheer"],
  ["vain", "vein", "vane"],
  ["waive", "wave"],
  ["wander", "wonder"],
  ["wreak", "wreck"],
];
