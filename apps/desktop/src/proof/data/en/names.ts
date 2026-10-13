// Written for this app.

/** Words that are both a name and an ordinary word: never weighed for
 *  their capital (Will and will, Rose and rose). */
export const NAME_HOMOGRAPHS = new Set(
  (
    "will rose mark may march august bill grace hope faith joy dawn summer autumn winter spring lily daisy iris ivy violet amber ruby pearl jack john frank pat bob rob sue rich art gene ray dean earl duke king prince queen baker smith cook taylor carter mason hunter " +
    "fisher miller turner walker cooper potter brown green white black gray grey young long short stone wood woods hill lake rivers brook ford lane west east north south china turkey polish bishop abbot dean major sergeant judge justice chase page " +
    "penny holly heather hazel ginger olive rosemary basil sage reed rusty sandy lance pierce drew nick dick bud chip cliff dale glen heath marsh moss peat rock sky storm wade"
  ).split(" "),
);

/** Abbreviations everyone knows: never asked for a definition. */
export const KNOWN_ABBREVIATIONS = new Set(
  (
    "USA UK US EU UN TV OK AM PM AD BC BCE CE DNA RNA CEO CFO FBI CIA NASA NATO BBC CNN GPS ATM CD DVD PC IT HR PR VIP RSVP ASAP FAQ AI DIY ID PDF URL USB WIFI SUV UFO HIV AIDS IQ PhD MD MA BA BS MBA PS PPS ETA TBA TBC TBD " +
    "NYC LA DC HQ POW MIA RIP SOS AKA FYI TLC ER ICU IV MRI CPR ADHD PTSD OCD NHS RAF SAS MP PM QC KC OBE MBE RSPCA AA RAC DVLA GMT BST EST PST UTC"
  ).split(" "),
);

/** Words that stand in the middle of a list as an aside, not as an item. */
export const ASIDES = new Set("however though too then therefore indeed instead perhaps maybe meanwhile besides also still anyway".split(" "));
