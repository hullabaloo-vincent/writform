// Shortenings that end in a full stop without ending the sentence. Used to
// tell where sentences begin, in any language (it only ever makes the
// reading more careful). Written for this app.
/** Titles that stand before a name: the word after one is a name, in the
 *  middle of its sentence for certain. */
export const TITLES = new Set("mr mrs ms dr prof st sr messrs mme mlle capt sgt lt cmdr maj col gen gov sen rep rev hon".split(" "));

export const ABBREVIATIONS = new Set(
  (
    "mr mrs ms dr prof st sr jr mt ft vs etc inc ltd co corp no nos vol vols fig figs approx dept est gen col capt sgt lt cmdr maj gov sen rep rev hon messrs mme mlle ave blvd rd " +
    "jan feb mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun al cf viz ca ed eds pp p ch chap sec par op cit ibid tel ext"
  ).split(" "),
);
