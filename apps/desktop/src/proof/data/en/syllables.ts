// Words whose syllables the counting rule gets wrong, as "word:count".
// Written for this app.
const TABLE =
  "the:1 are:1 were:1 where:1 there:1 here:1 one:1 once:1 done:1 gone:1 some:1 come:1 give:1 have:1 love:1 live:1 move:1 eye:1 eyes:1 " +
  "people:2 every:2 evening:2 different:2 business:2 family:3 several:2 interesting:3 beautiful:3 area:3 idea:3 real:1 really:2 being:2 doing:2 going:2 seeing:2 " +
  "quiet:2 science:2 diet:2 lion:2 poem:2 poet:2 poetry:3 create:2 created:3 creating:3 creature:2 riot:2 giant:2 ruin:2 fluid:2 museum:3 video:3 radio:3 piano:3 violin:3 " +
  "fire:1 hour:1 our:1 flower:2 power:2 tower:2 hire:1 tire:1 wire:1 desire:2 entire:2 " +
  "queue:1 tongue:1 league:1 vague:1 plague:1 rhythm:2 prism:2 chasm:2 spasm:2 " +
  "somewhere:2 sometimes:2 something:2 someone:2 anyone:3 everyone:3 everything:3 everywhere:3 therefore:2 themselves:2 yourself:2 himself:2 herself:2 itself:2 ourselves:2 " +
  "wednesday:2 february:4 january:4 library:3 chocolate:2 camera:3 comfortable:3 vegetable:3 temperature:3 average:2 favourite:2 favorite:2 restaurant:2 mirror:2 " +
  "couldn't:2 wouldn't:2 shouldn't:2 didn't:2 doesn't:2 isn't:2 wasn't:2 hadn't:2 hasn't:2 haven't:2 aren't:1 weren't:1 don't:1 won't:1 can't:1 " +
  "opened:2 decided:3 clothes:1 marriage:2 carriage:2 naked:2 wicked:2 fruit:1 suit:1 juice:1 guard:1 language:2 equal:2 quality:3 quarter:2 square:1 ratio:3 recipe:3 simile:3 " +
  "special:2 social:2 official:3 initial:3 delicious:3 precious:2 anxious:2 conscious:2 ocean:2 friend:1 friends:1 view:1 beauty:2 again:2 against:2 said:1 says:1 does:1 goes:1 shoes:1";

export const SYLLABLES = new Map<string, number>(
  TABLE.split(" ").map((pair) => {
    const at = pair.lastIndexOf(":");
    return [pair.slice(0, at), Number(pair.slice(at + 1))];
  }),
);
