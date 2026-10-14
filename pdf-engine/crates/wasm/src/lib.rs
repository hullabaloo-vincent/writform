//! wfpdf-wasm: the PDF engine as the app calls it.
//!
//! One `PdfDoc` is one open PDF (see `session.rs`). Everything crosses to JavaScript as plain
//! things: bytes, numbers, and text that is JSON. A call that cannot be done throws JSON too:
//! `{"code": "...", "message": "..."}`, the code one of `NeedsPassword`, `WrongPassword`,
//! `Unsupported`, `NotPermitted` and `Invalid`.

pub mod forms;
pub mod frame;
pub mod marks;
pub mod session;
pub mod text;

use serde::Serialize;
use wasm_bindgen::prelude::*;

use session::{Fail, Session};

fn asked<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(|e| thrown(Fail::invalid(format!("the engine was asked for something it does not understand: {e}"))))
}

fn json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

fn thrown(fail: Fail) -> JsValue {
    JsValue::from_str(&json(&fail))
}

fn told<T: Serialize>(result: Result<T, Fail>) -> Result<String, JsValue> {
    result.map(|value| json(&value)).map_err(thrown)
}

fn indexes(pages: &[u32]) -> Vec<usize> {
    pages.iter().map(|&p| p as usize).collect()
}

#[wasm_bindgen]
pub struct PdfDoc {
    session: Session,
}

#[wasm_bindgen]
impl PdfDoc {
    /// Open a PDF from its bytes.
    #[wasm_bindgen(constructor)]
    pub fn open(bytes: Vec<u8>, password: Option<String>) -> Result<PdfDoc, JsValue> {
        Session::open(bytes, password.as_deref()).map(|session| PdfDoc { session }).map_err(thrown)
    }

    /// Its pages, its title, what may be done to it, and whether there is anything to undo.
    pub fn info(&self) -> String {
        json(&self.session.info())
    }

    pub fn rotate(&mut self, pages: &[u32], degrees: i32) -> Result<String, JsValue> {
        told(self.session.rotate(&indexes(pages), i64::from(degrees)))
    }

    #[wasm_bindgen(js_name = deletePages)]
    pub fn delete_pages(&mut self, pages: &[u32]) -> Result<String, JsValue> {
        told(self.session.delete_pages(&indexes(pages)))
    }

    #[wasm_bindgen(js_name = movePages)]
    pub fn move_pages(&mut self, pages: &[u32], to: u32) -> Result<String, JsValue> {
        told(self.session.move_pages(&indexes(pages), to as usize))
    }

    #[wasm_bindgen(js_name = duplicatePages)]
    pub fn duplicate_pages(&mut self, pages: &[u32]) -> Result<String, JsValue> {
        told(self.session.duplicate_pages(&indexes(pages)))
    }

    #[wasm_bindgen(js_name = insertBlank)]
    pub fn insert_blank(&mut self, at: u32, width: f64, height: f64) -> Result<String, JsValue> {
        told(self.session.insert_blank(at as usize, width, height))
    }

    /// Pages of another PDF, before page `at`. `pages` empty: all of them.
    #[wasm_bindgen(js_name = insertFrom)]
    pub fn insert_from(&mut self, other: Vec<u8>, password: Option<String>, pages: &[u32], at: u32) -> Result<String, JsValue> {
        let list = indexes(pages);
        told(self.session.insert_from(other, password.as_deref(), (!list.is_empty()).then_some(list.as_slice()), at as usize))
    }

    /// Some pages as a PDF of their own.
    pub fn extract(&self, pages: &[u32], now: f64) -> Result<Vec<u8>, JsValue> {
        self.session.extract(&indexes(pages), now as i64).map_err(thrown)
    }

    pub fn undo(&mut self) -> Result<String, JsValue> {
        told(self.session.undo())
    }

    pub fn redo(&mut self) -> Result<String, JsValue> {
        told(self.session.redo())
    }

    /// The document as a file (see `Session::save`).
    pub fn save(&self, full: bool, now: f64) -> Result<Vec<u8>, JsValue> {
        self.session.save(full, now as i64).map_err(thrown)
    }

    #[wasm_bindgen(js_name = markSaved)]
    pub fn mark_saved(&mut self, bytes: Vec<u8>) -> Result<(), JsValue> {
        self.session.mark_saved(bytes).map_err(thrown)
    }

    /// What time it is (seconds since 1970), for whatever is made next: nothing in here reads a
    /// clock.
    pub fn clock(&mut self, now: f64) {
        self.session.clock(now as i64);
    }

    // ---- marking up and signing (marks.rs)

    /// The marks on a page.
    pub fn marks(&self, page: u32) -> Result<String, JsValue> {
        told(self.session.marks(page as usize))
    }

    /// Make a mark (`mark` is a `NewMark` as JSON). `pixels`: a picture's, where the mark is one.
    #[wasm_bindgen(js_name = addMark)]
    pub fn add_mark(&mut self, mark: &str, pixels: Option<Vec<u8>>) -> Result<String, JsValue> {
        let new = asked(mark)?;
        told(self.session.add_mark(new, pixels.as_deref()))
    }

    #[wasm_bindgen(js_name = updateMark)]
    pub fn update_mark(&mut self, page: u32, index: u32, patch: &str) -> Result<String, JsValue> {
        let patch = asked(patch)?;
        told(self.session.update_mark(page as usize, index as usize, patch))
    }

    #[wasm_bindgen(js_name = deleteMark)]
    pub fn delete_mark(&mut self, page: u32, index: u32) -> Result<String, JsValue> {
        told(self.session.delete_mark(page as usize, index as usize))
    }

    // ---- forms (forms.rs)

    /// The form's fields.
    pub fn fields(&self) -> String {
        json(&self.session.fields())
    }

    /// Set a field (`value` is a `Value` as JSON: `{"text": "…"}`, `{"check": true}`…).
    #[wasm_bindgen(js_name = setField)]
    pub fn set_field(&mut self, name: &str, value: &str) -> Result<String, JsValue> {
        let value = asked(value)?;
        told(self.session.set_field(name, value))
    }

    /// Make what was filled in and signed part of the pages (all pages when none are named).
    #[wasm_bindgen(js_name = flattenFillSign)]
    pub fn flatten_fill_sign(&mut self, pages: &[u32]) -> Result<String, JsValue> {
        told(self.session.flatten_fill_sign(&indexes(pages)).map(|(_, change)| change))
    }

    // ---- text (text.rs)

    /// A page's own text, as blocks that can be changed.
    #[wasm_bindgen(js_name = textBlocks)]
    pub fn text_blocks(&self, page: u32) -> Result<String, JsValue> {
        told(self.session.text_blocks(page as usize))
    }

    #[wasm_bindgen(js_name = replaceBlock)]
    pub fn replace_block(&mut self, page: u32, block: u32, text: &str) -> Result<String, JsValue> {
        told(self.session.replace_block(page as usize, block as usize, text))
    }

    /// What was added to a page.
    pub fn added(&self, page: u32) -> Result<String, JsValue> {
        told(self.session.added(page as usize))
    }

    /// Put text on a page (`text` is a `NewText` as JSON).
    #[wasm_bindgen(js_name = addText)]
    pub fn add_text(&mut self, page: u32, text: &str) -> Result<String, JsValue> {
        let new = asked(text)?;
        told(self.session.add_text(page as usize, new).map(|(_, change)| change))
    }

    #[wasm_bindgen(js_name = updateText)]
    pub fn update_text(&mut self, page: u32, index: u32, text: &str) -> Result<String, JsValue> {
        let new = asked(text)?;
        told(self.session.update_text(page as usize, index as usize, new))
    }

    #[wasm_bindgen(js_name = deleteAdded)]
    pub fn delete_added(&mut self, page: u32, index: u32) -> Result<String, JsValue> {
        told(self.session.delete_added(page as usize, index as usize))
    }
}
