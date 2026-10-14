//! A page's own text, changed. And text added to a page.
//!
//! A PDF's text is glyphs set at places, not paragraphs: the engine groups them into blocks as
//! well as it can and lets one block be written again in the font it is in. Where that font
//! lacks a letter (most PDFs carry only the letters they use), the letter is set in a standard
//! font instead, and the caller is told. This is the least sure thing the engine does.

use serde::{Deserialize, Serialize};
use wfpdf_edit::added::{AddedText, Align, Content, Family};

use crate::frame::Frame;
use crate::session::{Change, Fail, Kind, Session};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    /// Its place among the page's blocks, good until the page's text is next changed.
    pub index: usize,
    pub text: String,
    /// Its box on the page as shown.
    pub rect: [f64; 4],
    pub font: String,
    pub size: f64,
    pub bold: bool,
    pub italic: bool,
    pub color: [f64; 3],
    /// Set at an angle, degrees.
    pub rotation: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rewritten {
    /// The font that stood in for letters the block's own font lacks, when one had to.
    pub substituted: Option<String>,
    pub change: Change,
}

/// Text to put on a page.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewText {
    /// Its box on the page as shown: as wide as the text may run, as tall as it turns out.
    pub rect: [f64; 4],
    pub text: String,
    /// `sans`, `serif` or `mono`.
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    pub size: f64,
    pub color: Option<[f64; 3]>,
    /// `left`, `center`, `right` or `justify`.
    #[serde(default)]
    pub align: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedInfo {
    /// Its place among what was added to the page.
    pub index: usize,
    pub rect: [f64; 4],
    /// Its words (none: it is a picture).
    pub text: Option<String>,
    pub size: Option<f64>,
}

fn added_text(frame: &Frame, new: &NewText) -> AddedText {
    AddedText {
        rect: frame.display_rect(new.rect),
        text: new.text.clone(),
        family: match new.family.as_str() {
            "serif" => Family::Times,
            "mono" => Family::Courier,
            _ => Family::Helvetica,
        },
        bold: new.bold,
        italic: new.italic,
        size: new.size.clamp(1.0, 500.0),
        color: new.color.unwrap_or([0.0, 0.0, 0.0]),
        align: match new.align.as_str() {
            "center" => Align::Center,
            "right" => Align::Right,
            "justify" => Align::Justify,
            _ => Align::Left,
        },
    }
}

impl Session {
    /// A page's text as blocks that can be changed (text nobody sees is left out).
    pub fn text_blocks(&self, page: usize) -> Result<Vec<BlockInfo>, Fail> {
        let frame = Frame::of(self.document(), page)?;
        Ok(wfpdf_edit::text_blocks(self.document(), page)?
            .into_iter()
            .enumerate()
            .filter(|(_, b)| !b.invisible && !b.editor_text.trim().is_empty())
            .map(|(index, b)| BlockInfo {
                index,
                text: b.editor_text,
                rect: frame.view_rect(b.rect),
                font: b.base_font,
                size: b.size,
                bold: b.bold,
                italic: b.italic,
                color: b.color,
                rotation: b.rotation,
            })
            .collect())
    }

    /// Write a block's text again.
    pub fn replace_block(&mut self, page: usize, block: usize, text: &str) -> Result<Rewritten, Fail> {
        let edit = self.change(Kind::Text, |doc| Ok(wfpdf_edit::replace_block(doc, page, block, text)?))?;
        Ok(Rewritten { substituted: edit.substituted, change: Change { changed_pages: vec![page], structure_changed: false } })
    }

    /// What has been added to a page here (or by the program this engine came from).
    pub fn added(&self, page: usize) -> Result<Vec<AddedInfo>, Fail> {
        let frame = Frame::of(self.document(), page)?;
        Ok(wfpdf_edit::added::list_added(self.document())
            .into_iter()
            .filter(|a| a.page == page)
            .enumerate()
            .map(|(index, a)| match &a.content {
                Content::Text(t) => {
                    AddedInfo { index, rect: frame.view_of_display(wfpdf_edit::added::text_rect(t)), text: Some(t.text.clone()), size: Some(t.size) }
                }
                Content::Image(i) => AddedInfo { index, rect: frame.view_of_display(i.rect), text: None, size: None },
            })
            .collect())
    }

    /// Put text on a page. Returns its place among what was added to that page.
    pub fn add_text(&mut self, page: usize, new: NewText) -> Result<(usize, Change), Fail> {
        if new.text.trim().is_empty() {
            return Err(Fail::invalid("there is nothing to add"));
        }
        let frame = Frame::of(self.document(), page)?;
        let content = Content::Text(added_text(&frame, &new));
        let index = self.change(Kind::Text, |doc| Ok(wfpdf_edit::added::add_content(doc, page, &content)?))?;
        Ok((index, Change { changed_pages: vec![page], structure_changed: false }))
    }

    /// Change text that was added.
    pub fn update_text(&mut self, page: usize, index: usize, new: NewText) -> Result<Change, Fail> {
        let frame = Frame::of(self.document(), page)?;
        let content = Content::Text(added_text(&frame, &new));
        self.change(Kind::Text, |doc| Ok(wfpdf_edit::added::update_content(doc, page, index, &content)?))?;
        Ok(Change { changed_pages: vec![page], structure_changed: false })
    }

    /// Take away something that was added.
    pub fn delete_added(&mut self, page: usize, index: usize) -> Result<Change, Fail> {
        self.change(Kind::Text, |doc| Ok(wfpdf_edit::added::delete_content(doc, page, index)?))?;
        Ok(Change { changed_pages: vec![page], structure_changed: false })
    }
}
