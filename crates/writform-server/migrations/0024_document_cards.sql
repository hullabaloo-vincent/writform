-- What a document's card shows in the lists: a synopsis, a picture of the
-- front cover and tags. Written by an editor of the document from its own
-- settings (`PUT /documents/{id}/card`), as the excerpt is from snapshots.
--
-- card_synopsis: the book's description (or a document's subject), cut short.
-- card_cover: `front <w>x<h> writform-att://attachment/N` or the same with
--   `wrap` (a whole cover, of which the card shows the right-hand part).
-- card_tags: a JSON array of short strings.
-- map_media: every server picture the document's settings name (cover
--   pieces, scene break, chapter art), each written as
--   `writform-att://attachment/N"`, so the people the document is shared
--   with may read them as they may read pictures in its text.

ALTER TABLE documents ADD COLUMN card_synopsis TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN card_cover TEXT;
ALTER TABLE documents ADD COLUMN card_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE documents ADD COLUMN map_media TEXT NOT NULL DEFAULT '';
