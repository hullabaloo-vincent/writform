//! One open PDF and what has been done to it.
//!
//! The engine's `Document` is cheap to copy (a copy shares everything that was not changed), so
//! undo is a list of documents: each change is made to a copy, and the one before it is kept.
//! Nothing here knows of JavaScript. `lib.rs` is the surface the app calls, and only passes
//! things through.
//!
//! Pages are counted from 0 throughout. Sizes are points, as a page is shown (after its rotation).

use std::sync::Arc;

use serde::Serialize;
use wfpdf_cos::{CosError, Document, Object, SaveOptions, pdf_date, write_full, write_incremental};
use wfpdf_organize::OrganizeError;

/// The most steps kept to undo. (Each is a copy that shares what it did not change.)
const UNDO_MOST: usize = 200;

/// Why something could not be done: a word for the app to tell cases apart by, and a sentence.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Fail {
    pub code: &'static str,
    pub message: String,
}

impl Fail {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("Invalid", message)
    }
}

impl From<CosError> for Fail {
    fn from(e: CosError) -> Self {
        let code = match e {
            CosError::NeedsPassword => "NeedsPassword",
            CosError::WrongPassword => "WrongPassword",
            CosError::Security(_) => "Unsupported",
            _ => "Invalid",
        };
        Self::new(code, e.to_string())
    }
}

impl From<OrganizeError> for Fail {
    fn from(e: OrganizeError) -> Self {
        match e {
            OrganizeError::Cos(inner) => inner.into(),
            other => Self::invalid(other.to_string()),
        }
    }
}

/// What a change touched, so the app redraws no more than it must.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Pages whose look changed, as they are numbered after the change.
    pub changed_pages: Vec<usize>,
    /// Pages were added, removed or moved: every page number may mean another page now.
    pub structure_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageInfo {
    /// Its size as shown, points.
    pub w: f64,
    pub h: f64,
    /// Clockwise: 0, 90, 180 or 270.
    pub rotation: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub pages: Vec<PageInfo>,
    pub title: Option<String>,
    /// Opened with a password (or protected without one).
    pub encrypted: bool,
    /// It carries a signature, which any change will break.
    pub signed: bool,
    /// What its owner allows. All true where it says nothing.
    pub may: May,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Changed since it was opened or last saved.
    pub modified: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct May {
    pub change_pages: bool,
    pub annotate: bool,
    pub fill_forms: bool,
    pub change_text: bool,
}

/// What a change is, for asking whether the document's owner allows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Pages,
    Annotate,
    Forms,
    Text,
}

pub struct Session {
    doc: Document,
    password: Option<String>,
    undo: Vec<Document>,
    redo: Vec<Document>,
    /// How many changes ago it was saved (None: a step that can no longer be got back to).
    saved_at: Option<usize>,
    /// The time to stamp what is made with, seconds since 1970 (the app says: nothing here
    /// reads a clock), and a count that makes each thing's name its own.
    pub(crate) now: i64,
    pub(crate) counter: u64,
}

fn all(count: usize) -> Vec<usize> {
    (0..count).collect()
}

impl Session {
    /// Open a PDF. A file with a password says `NeedsPassword` without one, and `WrongPassword`
    /// with the wrong one.
    pub fn open(bytes: Vec<u8>, password: Option<&str>) -> Result<Self, Fail> {
        let doc = Document::open_with_password(Arc::new(bytes), password.filter(|p| !p.is_empty()))?;
        if wfpdf_organize::page_count(&doc)? == 0 {
            return Err(Fail::invalid("this PDF has no pages"));
        }
        Ok(Self {
            doc,
            password: password.filter(|p| !p.is_empty()).map(str::to_owned),
            undo: Vec::new(),
            redo: Vec::new(),
            saved_at: Some(0),
            now: 0,
            counter: 0,
        })
    }

    /// What time it is, for whatever is made next.
    pub fn clock(&mut self, now: i64) {
        self.now = now;
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    pub fn page_count(&self) -> usize {
        wfpdf_model::pages(&self.doc).len()
    }

    pub fn may(&self) -> May {
        match self.doc.permissions() {
            None => May { change_pages: true, annotate: true, fill_forms: true, change_text: true },
            Some(p) => May {
                change_pages: p.owner || p.assemble() || p.modify(),
                annotate: p.owner || p.annotate() || p.modify(),
                fill_forms: p.owner || p.fill_forms() || p.annotate() || p.modify(),
                change_text: p.owner || p.modify(),
            },
        }
    }

    fn signed(&self) -> bool {
        let Some(root) = self.doc.root() else { return false };
        let Some(catalog) = self.doc.dict(&self.doc.get(root)) else { return false };
        let Some(form) = catalog.get(b"AcroForm").and_then(|f| self.doc.dict(f)) else { return false };
        matches!(form.get(b"SigFlags").map(|v| self.doc.resolve(v)).as_deref(), Some(Object::Int(flags)) if flags & 1 == 1)
    }

    pub fn info(&self) -> Info {
        let pages = wfpdf_model::pages(&self.doc)
            .iter()
            .map(|page| {
                let (w, h) = page.display_size(&self.doc);
                PageInfo { w, h, rotation: page.rotation(&self.doc) }
            })
            .collect();
        Info {
            pages,
            title: wfpdf_organize::info(&self.doc, "Title").filter(|t| !t.trim().is_empty()),
            encrypted: self.doc.security().is_some(),
            signed: self.signed(),
            may: self.may(),
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            modified: self.saved_at != Some(self.undo.len()),
        }
    }

    fn allowed(&self, kind: Kind) -> Result<(), Fail> {
        let may = self.may();
        let ok = match kind {
            Kind::Pages => may.change_pages,
            Kind::Annotate => may.annotate,
            Kind::Forms => may.fill_forms,
            Kind::Text => may.change_text,
        };
        if ok { Ok(()) } else { Err(Fail::new("NotPermitted", "whoever made this PDF does not allow that change")) }
    }

    /// Make a change: on a copy, which becomes the document only if the change went through.
    pub fn change<T>(&mut self, kind: Kind, f: impl FnOnce(&mut Document) -> Result<T, Fail>) -> Result<T, Fail> {
        self.allowed(kind)?;
        let mut next = self.doc.clone();
        let out = f(&mut next)?;
        self.undo.push(std::mem::replace(&mut self.doc, next));
        self.redo.clear();
        if self.undo.len() > UNDO_MOST {
            self.undo.remove(0);
            // (The step it was saved at may be the one let go.)
            self.saved_at = self.saved_at.and_then(|at| at.checked_sub(1));
        }
        Ok(out)
    }

    fn pages_exist(&self, pages: &[usize]) -> Result<(), Fail> {
        let count = self.page_count();
        if pages.is_empty() {
            return Err(Fail::invalid("no pages were named"));
        }
        match pages.iter().find(|&&p| p >= count) {
            Some(p) => Err(Fail::invalid(format!("there is no page {}", p + 1))),
            None => Ok(()),
        }
    }

    /// Turn pages by a quarter turn or more (clockwise, a multiple of 90).
    pub fn rotate(&mut self, pages: &[usize], degrees: i64) -> Result<Change, Fail> {
        self.pages_exist(pages)?;
        self.change(Kind::Pages, |doc| Ok(wfpdf_organize::rotate_pages(doc, pages, degrees)?))?;
        Ok(Change { changed_pages: pages.to_vec(), structure_changed: false })
    }

    pub fn delete_pages(&mut self, pages: &[usize]) -> Result<Change, Fail> {
        self.pages_exist(pages)?;
        self.change(Kind::Pages, |doc| Ok(wfpdf_organize::delete_pages(doc, pages)?))?;
        Ok(self.restructured())
    }

    /// Move pages (keeping their order among themselves) to start at `to`, counted among the
    /// pages that are left once they are taken out.
    pub fn move_pages(&mut self, pages: &[usize], to: usize) -> Result<Change, Fail> {
        self.pages_exist(pages)?;
        self.change(Kind::Pages, |doc| Ok(wfpdf_organize::move_pages(doc, pages, to)?))?;
        Ok(self.restructured())
    }

    /// Copy pages. The copies go in after the last of them.
    pub fn duplicate_pages(&mut self, pages: &[usize]) -> Result<Change, Fail> {
        self.pages_exist(pages)?;
        self.change(Kind::Pages, |doc| Ok(wfpdf_organize::duplicate_pages(doc, pages)?))?;
        Ok(self.restructured())
    }

    /// Put an empty page in before page `at` (after the last, when `at` is the page count).
    pub fn insert_blank(&mut self, at: usize, width: f64, height: f64) -> Result<Change, Fail> {
        if !(width.is_finite() && height.is_finite() && (1.0..=14400.0).contains(&width) && (1.0..=14400.0).contains(&height)) {
            return Err(Fail::invalid("a page is between 1 and 14400 points each way"));
        }
        self.change(Kind::Pages, |doc| Ok(wfpdf_organize::insert_blank_page(doc, at, width, height).map(|_| ())?))?;
        Ok(self.restructured())
    }

    /// Put pages of another PDF in before page `at`: all of them, or those named, in that order.
    pub fn insert_from(&mut self, other: Vec<u8>, password: Option<&str>, pages: Option<&[usize]>, at: usize) -> Result<Change, Fail> {
        let source = Document::open_with_password(Arc::new(other), password.filter(|p| !p.is_empty()))?;
        let count = wfpdf_organize::page_count(&source)?;
        let wanted = match pages {
            Some(list) => list.to_vec(),
            None => all(count),
        };
        if wanted.is_empty() || wanted.iter().any(|&p| p >= count) {
            return Err(Fail::invalid("the other PDF does not have those pages"));
        }
        self.change(Kind::Pages, |doc| Ok(wfpdf_organize::import_pages(doc, &source, &wanted, at).map(|_| ())?))?;
        Ok(self.restructured())
    }

    /// Some pages as a PDF of their own. (The document itself is not changed.)
    pub fn extract(&self, pages: &[usize], now: i64) -> Result<Vec<u8>, Fail> {
        self.pages_exist(pages)?;
        let out = wfpdf_organize::extract_pages(&self.doc, pages)?;
        Ok(write_full(&out, &Self::options(now))?)
    }

    fn restructured(&self) -> Change {
        Change { changed_pages: all(self.page_count()), structure_changed: true }
    }

    pub fn undo(&mut self) -> Result<Change, Fail> {
        let before = self.undo.pop().ok_or_else(|| Fail::invalid("nothing to undo"))?;
        self.redo.push(std::mem::replace(&mut self.doc, before));
        Ok(self.restructured())
    }

    pub fn redo(&mut self) -> Result<Change, Fail> {
        let after = self.redo.pop().ok_or_else(|| Fail::invalid("nothing to redo"))?;
        self.undo.push(std::mem::replace(&mut self.doc, after));
        Ok(self.restructured())
    }

    fn options(now: i64) -> SaveOptions {
        SaveOptions { mod_date: (now > 0).then(|| pdf_date(now)), ..SaveOptions::default() }
    }

    /// The document as a file. `full` writes it afresh, with nothing of what was taken out left
    /// inside. Otherwise the changes are added to the end of the file as it was opened, which is
    /// quick and keeps what the file had (a signature stays checkable up to where it signed).
    /// `now` is the time to stamp it with, seconds since 1970 (0: no stamp).
    pub fn save(&self, full: bool, now: i64) -> Result<Vec<u8>, Fail> {
        let opts = Self::options(now);
        Ok(if full { write_full(&self.doc, &opts)? } else { write_incremental(&self.doc, &opts)? })
    }

    /// The bytes just saved are the file now: later saves build on them.
    pub fn mark_saved(&mut self, bytes: Vec<u8>) -> Result<(), Fail> {
        self.doc = Document::open_with_password(Arc::new(bytes), self.password.as_deref())?;
        self.saved_at = Some(self.undo.len());
        Ok(())
    }
}
