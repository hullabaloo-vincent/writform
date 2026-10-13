// Verbs that report speech. Written for this app.
export const SPEECH_VERBS = new Set(
  (
    "said say says saying asked ask asks asking replied reply replies answered answer answers whispered whisper whispers shouted shout shouts yelled yell yells cried cry cries called call calls " +
    "muttered mutter mutters murmured murmur murmurs mumbled mumble mumbles screamed scream screams shrieked snapped snap snaps growled growl growls hissed hiss hisses barked snarled " +
    "sighed breathed gasped groaned moaned sobbed wailed whimpered whined laughed chuckled giggled " +
    "added add adds continued continue continues began begin begins went started finished concluded repeated repeat repeats echoed " +
    "told tell tells explained explain explains announced declared stated insisted demanded demand demands begged pleaded urged ordered commanded warned promised admitted confessed agreed " +
    "argued protested objected interrupted suggested offered wondered mused remarked observed noted commented exclaimed stammered stuttered drawled croaked rasped bellowed roared thundered " +
    "lied joked teased mocked sneered scoffed retorted countered responded inquired enquired queried guessed"
  ).split(" "),
);

/** The plain tags, which the eye passes over. */
export const PLAIN_TAGS = new Set("said says say asked asks ask".split(" "));

/** Things a person does while speaking that are not speaking. As a tag
 *  ("Go," she smiled) they are a slip: nobody smiles a word. */
export const ACTION_VERBS = new Set(
  "smiled grinned nodded shrugged frowned winked laughed chuckled giggled sighed snorted sniffed beamed smirked scowled glared gestured pointed waved paused shivered blinked grimaced winced yawned coughed gulped swallowed blushed".split(" "),
);
