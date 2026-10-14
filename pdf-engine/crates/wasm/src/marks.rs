//! Marking a PDF up: highlights, notes, drawing, shapes, typed text. And signing it.
//!
//! These are annotations: they lie over the page and stay their own things, which any PDF reader
//! shows and can take away again. Each is known by its page and its place among that page's
//! annotations, and those places shift when one is added or taken out: list them again after
//! every change.

use serde::{Deserialize, Serialize};
use wfpdf_annot::{AnnotError, LineEnding, Markup, Meta, NewAnnotation, NoteIcon, Shape, Style};
use wfpdf_cos::{Dict, Document, ObjRef, Object, Stream, pdf_date};

use crate::frame::Frame;
use crate::session::{Change, Fail, Kind, Session};

impl From<AnnotError> for Fail {
    fn from(e: AnnotError) -> Self {
        match e {
            AnnotError::Cos(inner) => inner.into(),
            AnnotError::Unsupported(m) => Fail::new("Unsupported", m),
            other => Fail::invalid(other.to_string()),
        }
    }
}

/// A mark to make, as the app says it. Boxes are `[x, y, width, height]`, points are `[x, y]`:
/// points of the page as shown, from its top left.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Mark {
    /// Over lines of text: one box to each line.
    Highlight {
        rects: Vec<[f64; 4]>,
    },
    Underline {
        rects: Vec<[f64; 4]>,
    },
    Strikeout {
        rects: Vec<[f64; 4]>,
    },
    /// A note: its mark on the page, what it says in `text`.
    Note {
        at: [f64; 2],
    },
    /// Drawn by hand.
    Ink {
        strokes: Vec<Vec<[f64; 2]>>,
    },
    Rect {
        rect: [f64; 4],
    },
    Oval {
        rect: [f64; 4],
    },
    Line {
        from: [f64; 2],
        to: [f64; 2],
        #[serde(default)]
        arrow: bool,
    },
    /// Words typed onto the page (`text`), `size` points tall.
    Text {
        rect: [f64; 4],
        size: f64,
    },
    /// A signature drawn by hand.
    Signature {
        strokes: Vec<Vec<[f64; 2]>>,
    },
    /// A signature that is a picture, `w` by `h` pixels: the pixels themselves (red, green, blue
    /// and how solid, a byte each) are handed over beside this.
    Picture {
        rect: [f64; 4],
        w: u32,
        h: u32,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMark {
    pub page: usize,
    #[serde(flatten)]
    pub mark: Mark,
    /// Red, green and blue, each 0 to 1.
    pub color: Option<[f64; 3]>,
    pub opacity: Option<f64>,
    /// A line's thickness, points.
    pub width: Option<f64>,
    pub fill: Option<[f64; 3]>,
    pub text: Option<String>,
    pub author: Option<String>,
}

/// What can be changed about a mark that is there.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkPatch {
    /// Move it so far right and so far down.
    pub by: Option<[f64; 2]>,
    pub rect: Option<[f64; 4]>,
    pub text: Option<String>,
    pub color: Option<[f64; 3]>,
    pub opacity: Option<f64>,
    pub width: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkInfo {
    pub index: usize,
    /// What the file calls it: `Highlight`, `Text` (a note), `Ink`, `Square`, `FreeText`…
    pub subtype: String,
    pub text: Option<String>,
    pub author: Option<String>,
    /// Its box on the page as shown.
    pub rect: [f64; 4],
    pub color: Option<[f64; 3]>,
    pub locked: bool,
    /// Put there by filling or signing (a signature, a tick).
    pub fill_sign: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Made {
    /// Where it is among its page's marks.
    pub index: usize,
    pub change: Change,
}

const MOST_PIXELS: usize = 8_000_000;

/// A picture as an object of the document: its colours, and how solid each pixel is.
fn picture(doc: &mut Document, rgba: &[u8], width: u32, height: u32) -> Result<ObjRef, Fail> {
    let count = width as usize * height as usize;
    if count == 0 || count > MOST_PIXELS || rgba.len() != count * 4 {
        return Err(Fail::invalid("that picture cannot be used"));
    }
    let mut rgb = Vec::with_capacity(count * 3);
    let mut alpha = Vec::with_capacity(count);
    for [r, g, b, a] in rgba.as_chunks::<4>().0 {
        rgb.extend_from_slice(&[*r, *g, *b]);
        alpha.push(*a);
    }
    let base = |space: &[u8]| {
        let mut d = Dict::new();
        d.set(b"Type".to_vec(), Object::Name(b"XObject".to_vec()));
        d.set(b"Subtype".to_vec(), Object::Name(b"Image".to_vec()));
        d.set(b"Width".to_vec(), Object::Int(i64::from(width)));
        d.set(b"Height".to_vec(), Object::Int(i64::from(height)));
        d.set(b"ColorSpace".to_vec(), Object::Name(space.to_vec()));
        d.set(b"BitsPerComponent".to_vec(), Object::Int(8));
        d
    };
    let mut colours = base(b"DeviceRGB");
    if alpha.iter().any(|a| *a < 255) {
        let mask = doc.add(Object::Stream(Stream::flate(base(b"DeviceGray"), &alpha)));
        colours.set(b"SMask".to_vec(), Object::Ref(mask));
    }
    Ok(doc.add(Object::Stream(Stream::flate(colours, &rgb))))
}

impl Session {
    pub(crate) fn meta(&mut self) -> Meta {
        self.counter += 1;
        Meta { date: (self.now > 0).then(|| pdf_date(self.now)), id: format!("wf-{}-{}", self.now, self.counter) }
    }

    /// The marks on a page, in the order the file keeps them.
    pub fn marks(&self, page: usize) -> Result<Vec<MarkInfo>, Fail> {
        let frame = Frame::of(self.document(), page)?;
        Ok(wfpdf_annot::summaries(self.document())
            .into_iter()
            .filter(|s| s.page == page && s.subtype != "Popup" && s.subtype != "Widget" && s.subtype != "Link")
            .map(|s| MarkInfo {
                index: s.index,
                subtype: s.subtype,
                text: s.contents.filter(|t| !t.is_empty()),
                author: s.author.filter(|a| !a.is_empty()),
                rect: frame.view_rect([f64::from(s.rect[0]), f64::from(s.rect[1]), f64::from(s.rect[2]), f64::from(s.rect[3])]),
                color: s.color.map(|c| [f64::from(c[0]), f64::from(c[1]), f64::from(c[2])]),
                locked: s.locked,
                fill_sign: s.fill_sign,
            })
            .collect())
    }

    /// Make a mark. `pixels` is a picture's, for a mark that is one.
    pub fn add_mark(&mut self, new: NewMark, pixels: Option<&[u8]>) -> Result<Made, Fail> {
        let frame = Frame::of(self.document(), new.page)?;
        let page = new.page;
        let markup = |kind: Markup, rects: &[[f64; 4]]| -> Result<Shape, Fail> {
            if rects.is_empty() {
                return Err(Fail::invalid("nothing was marked"));
            }
            Ok(Shape::TextMarkup { kind, quads: rects.iter().map(|r| frame.quad(*r)).collect() })
        };
        let strokes = |list: &[Vec<[f64; 2]>]| -> Result<Vec<Vec<[f64; 2]>>, Fail> {
            let out: Vec<Vec<[f64; 2]>> = list.iter().filter(|s| !s.is_empty()).map(|s| s.iter().map(|p| frame.user(*p)).collect()).collect();
            if out.is_empty() { Err(Fail::invalid("nothing was drawn")) } else { Ok(out) }
        };
        let signing = matches!(new.mark, Mark::Signature { .. } | Mark::Picture { .. });
        let meta = self.meta();
        let author = new.author.clone().unwrap_or_default();
        let contents = new.text.clone().unwrap_or_default();
        let index = self.change(if signing { Kind::Forms } else { Kind::Annotate }, |doc| {
            let shape = match &new.mark {
                Mark::Highlight { rects } => markup(Markup::Highlight, rects)?,
                Mark::Underline { rects } => markup(Markup::Underline, rects)?,
                Mark::Strikeout { rects } => markup(Markup::StrikeOut, rects)?,
                Mark::Note { at } => Shape::Note { at: frame.user(*at), icon: NoteIcon::Comment },
                Mark::Ink { strokes: s } => Shape::Ink { strokes: strokes(s)? },
                Mark::Rect { rect } => Shape::Rectangle { rect: frame.user_rect(*rect) },
                Mark::Oval { rect } => Shape::Oval { rect: frame.user_rect(*rect) },
                Mark::Line { from, to, arrow } => Shape::Line {
                    from: frame.user(*from),
                    to: frame.user(*to),
                    start: LineEnding::None,
                    end: if *arrow { LineEnding::OpenArrow } else { LineEnding::None },
                },
                Mark::Text { rect, size } => Shape::Typewriter { rect: frame.user_rect(*rect), font_size: size.clamp(4.0, 144.0) },
                Mark::Signature { strokes: s } => Shape::Signature { strokes: strokes(s)? },
                Mark::Picture { rect, w, h } => {
                    let pixels = pixels.ok_or_else(|| Fail::invalid("the picture is missing"))?;
                    let object = picture(doc, pixels, *w, *h)?;
                    Shape::CustomStamp {
                        rect: frame.user_rect(*rect),
                        name: "Signature".into(),
                        picture: object,
                        image: true,
                        size: (f64::from(*w), f64::from(*h)),
                    }
                }
            };
            let mut style = Style::default_for(&shape);
            if let Some(color) = new.color {
                style.color = color;
            }
            if let Some(opacity) = new.opacity {
                style.opacity = opacity.clamp(0.05, 1.0);
            }
            if let Some(width) = new.width {
                style.width = width.clamp(0.0, 24.0);
            }
            if new.fill.is_some() {
                style.fill = new.fill;
            }
            Ok(wfpdf_annot::add_annotation(doc, &NewAnnotation { page, shape, style, contents, author }, &meta)?)
        })?;
        Ok(Made { index, change: Change { changed_pages: vec![page], structure_changed: false } })
    }

    /// Change a mark that is there: where it is, what it says, how it looks.
    pub fn update_mark(&mut self, page: usize, index: usize, patch: MarkPatch) -> Result<Change, Fail> {
        let frame = Frame::of(self.document(), page)?;
        let meta = self.meta();
        self.change(Kind::Annotate, |doc| {
            if let Some(by) = patch.by {
                let d = frame.user_step(by);
                wfpdf_annot::move_annotation(doc, page, index, d[0], d[1], &meta)?;
            }
            if let Some(rect) = patch.rect {
                wfpdf_annot::set_rect(doc, page, index, frame.user_rect(rect), &meta)?;
            }
            if let Some(text) = &patch.text {
                wfpdf_annot::set_contents(doc, page, index, text, &meta)?;
            }
            if patch.color.is_some() || patch.opacity.is_some() || patch.width.is_some() {
                wfpdf_annot::set_style(doc, page, index, patch.color, patch.opacity, patch.width, None, &meta)?;
            }
            Ok(())
        })?;
        Ok(Change { changed_pages: vec![page], structure_changed: false })
    }

    pub fn delete_mark(&mut self, page: usize, index: usize) -> Result<Change, Fail> {
        self.change(Kind::Annotate, |doc| Ok(wfpdf_annot::delete_annotation(doc, page, index)?))?;
        Ok(Change { changed_pages: vec![page], structure_changed: false })
    }
}
