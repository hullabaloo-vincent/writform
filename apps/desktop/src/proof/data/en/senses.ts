// Words that name what a sense takes in. Each word is in one list only.
// Written for this app.
export const SENSES: { id: string; label: string; words: Set<string> }[] = [
  {
    id: "sight",
    label: "Sight",
    words: new Set(
      "saw see seen look looked looking watch watched glance glanced gaze gazed stare stared glimpse glimpsed bright dark dim shadow shadows light glow glowed gleam gleamed glitter shine shone shimmer flicker flickered colour color red blue green yellow white black grey gray golden silver pale vivid shape outline blur sparkle glint".split(
        " ",
      ),
    ),
  },
  {
    id: "sound",
    label: "Sound",
    words: new Set(
      "heard hear hearing listen listened sound sounds noise loud quiet silence silent whisper whispered murmur shout shouted cry cried scream roar roared rumble rumbled crash crashed bang thud click clicked creak creaked rustle rustled hum hummed buzz ring rang echo echoed hiss hissed hush voice voices clatter splash".split(
        " ",
      ),
    ),
  },
  {
    id: "touch",
    label: "Touch",
    words: new Set(
      "touch touched feel rough smooth soft hard cold warm hot cool wet dry damp sticky slick sharp blunt heavy rubbed stroke stroked grip gripped squeeze squeezed press pressed brush brushed prickle tingle tingled sting stung ache ached shiver shivered tremble trembled numb coarse silky".split(
        " ",
      ),
    ),
  },
  {
    id: "smell",
    label: "Smell",
    words: new Set("smell smelled smelt scent scented odour odor stink stank stench reek reeked aroma fragrance fragrant perfume whiff musty sniff sniffed pungent acrid".split(" ")),
  },
  {
    id: "taste",
    label: "Taste",
    words: new Set("taste tasted sweet sour bitter salty salt savoury savory spicy bland flavour flavor tang tangy delicious sugary sip sipped swallow swallowed chew chewed lick licked".split(" ")),
  },
];
