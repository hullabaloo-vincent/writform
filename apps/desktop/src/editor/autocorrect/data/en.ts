// Slips of the fingers that are never a word, and what was meant. Written
// for this app (the larger list beside it, enLibreOffice.ts, is LibreOffice's): common mistypings and misspellings of everyday English
// words, each checked to be no word of its own (so that nothing a writer
// means is ever changed). A writer adds their own in Settings.
//
// Lowercase here. A word typed with a capital keeps it.

const PAIRS =
  "teh the|adn and|nad and|hte the|taht that|thta that|tihs this|thsi this|waht what|whta what|wich which|whcih which|" +
  "wiht with|wtih with|witht with|woudl would|wuold would|coudl could|shoudl should|becuase because|beacuse because|" +
  "becasue because|beleive believe|belive believe|recieve receive|recieved received|acheive achieve|acheived achieved|" +
  "freind friend|freinds friends|wierd weird|thier their|tehir their|theri their|seperate separate|seperately separately|" +
  "definately definitely|definatly definitely|definitly definitely|occured occurred|occuring occurring|occurence occurrence|" +
  "untill until|accomodate accommodate|accomodation accommodation|goverment government|" +
  "tommorow tomorrow|tommorrow tomorrow|tomorow tomorrow|alot a lot|adress address|begining beginning|beggining beginning|" +
  "buisness business|bussiness business|completly completely|concious conscious|dissapear disappear|dissapoint disappoint|" +
  "embarass embarrass|enviroment environment|existance existence|foriegn foreign|fourty forty|garantee guarantee|" +
  "happend happened|immediatly immediately|knowlege knowledge|liason liaison|libary library|" +
  "mispell misspell|neccessary necessary|necesary necessary|noticable noticeable|occassion occasion|occasionaly occasionally|" +
  "peice piece|persue pursue|posession possession|prefered preferred|privelege privilege|probaly probably|" +
  "realy really|reccomend recommend|recomend recommend|refered referred|relevent relevant|remeber remember|rythm rhythm|" +
  "sieze seize|similiar similar|speach speech|succesful successful|suprise surprise|suprised surprised|tounge tongue|" +
  "truely truly|unfortunatly unfortunately|usualy usually|writting writing|yuo you|yuor your|youre you’re|" +
  "abotu about|agian again|alwasy always|aroudn around|basicly basically|comming coming|diffrent different|doign doing|" +
  "esle else|evrey every|frist first|goign going|haev have|hvae have|jsut just|knwo know|liek like|litle little|mroe more|" +
  "nwo now|onyl only|otehr other|peopel people|poeple people|sicne since|soem some|somethign something|stil still|" +
  "tahn than|thign thing|thigns things|thikn think|thnak thank|togehter together|udnerstand understand|veyr very|wnat want|wokr work";

/** `"teh the|alot a lot"` as pairs (what follows the first space is the whole of what was meant). */
export const pairs = (list: string): [string, string][] =>
  list.split("|").map((pair): [string, string] => {
    const at = pair.indexOf(" ");
    return [pair.slice(0, at), pair.slice(at + 1)];
  });

/** A slip, and the word it stands for. */
export const TYPOS: ReadonlyMap<string, string> = new Map(pairs(PAIRS));

// Contractions typed without their apostrophe, where the bare letters are
// no word of their own. (Left out on purpose because they ARE words: its,
// were, well, hell, shell, ill, wed, id, wont, lets, cant.)
const BARE =
  "dont don’t|didnt didn’t|doesnt doesn’t|isnt isn’t|wasnt wasn’t|werent weren’t|arent aren’t|wouldnt wouldn’t|" +
  "couldnt couldn’t|shouldnt shouldn’t|hasnt hasn’t|havent haven’t|hadnt hadn’t|mustnt mustn’t|neednt needn’t|" +
  "im I’m|ive I’ve|youve you’ve|weve we’ve|theyve they’ve|theyre they’re|youll you’ll|theyll they’ll|itll it’ll|" +
  "thatll that’ll|thats that’s|whats what’s|heres here’s|theres there’s|wheres where’s|whos who’s|" +
  "shouldve should’ve|couldve could’ve|wouldve would’ve";

export const CONTRACTIONS: ReadonlyMap<string, string> = new Map(pairs(BARE));

/** "i" alone is "I". */
export const LONE_I = "i";
