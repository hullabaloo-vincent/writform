// Words that are meant to look like slips of the shift key and are not.
// Written for this app.

/** A small letter and then capitals, as the word is spelled. */
export const KEEP_INVERTED: ReadonlySet<string> = new Set("iOS iPadOS mRNA tRNA rRNA siRNA eSIM iSCSI pH dB kW kWh mAh".split(" "));

/** Two capitals and then small letters, as the word is spelled. */
export const KEEP_TWO_CAPITALS: ReadonlySet<string> = new Set("IDs CDs PCs TVs DJs GBs KBs MBs TBs VMs PhD MSc BSc McC".split(" "));
