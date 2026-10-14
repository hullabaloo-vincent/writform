//! Filling a PDF's form in.
//!
//! A field is known by its whole name (`applicant.surname`). Setting one draws it again as it
//! will show, and works out any field that is calculated from it.

use serde::{Deserialize, Serialize};
use wfpdf_edit::EditError;
use wfpdf_forms::{FieldKind, FieldValue, FormError, flags};

use crate::frame::Frame;
use crate::session::{Change, Fail, Kind, Session};

impl From<FormError> for Fail {
    fn from(e: FormError) -> Self {
        match e {
            FormError::Cos(inner) => inner.into(),
            FormError::ReadOnly(_) => Fail::new("NotPermitted", "that field cannot be changed"),
            other => Fail::invalid(other.to_string()),
        }
    }
}

impl From<EditError> for Fail {
    fn from(e: EditError) -> Self {
        match e {
            EditError::Cos(inner) => inner.into(),
            other => Fail::invalid(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetInfo {
    pub page: usize,
    /// Its box on the page as shown.
    pub rect: [f64; 4],
    /// For a tick box or one button of a set: the value it stands for, and whether it is on.
    pub on_state: Option<String>,
    pub on: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub name: String,
    /// `text`, `check`, `radio`, `combo`, `list`, `button` or `signature`.
    pub kind: &'static str,
    pub value: Vec<String>,
    /// For a choice: each value, and how it is shown.
    pub options: Vec<(String, String)>,
    pub read_only: bool,
    pub required: bool,
    pub multiline: bool,
    pub password: bool,
    pub many: bool,
    pub max_len: Option<usize>,
    pub tooltip: Option<String>,
    pub widgets: Vec<WidgetInfo>,
}

/// What to set a field to.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Value {
    Text(String),
    Check(bool),
    /// The one chosen of a set (none: `null`).
    Radio(Option<String>),
    Choice(Vec<String>),
}

impl Session {
    /// The form's fields, in the order the file keeps them. None where there is no form.
    pub fn fields(&self) -> Vec<FieldInfo> {
        let doc = self.document();
        wfpdf_forms::fields(doc)
            .into_iter()
            .map(|f| {
                let widgets = f
                    .widgets
                    .iter()
                    .filter(|w| !w.hidden)
                    .filter_map(|w| {
                        let page = w.page?;
                        let frame = Frame::of(doc, page).ok()?;
                        let on = match (&w.state, &w.on_state) {
                            (Some(state), Some(on)) => state == on,
                            _ => false,
                        };
                        Some(WidgetInfo { page, rect: frame.view_rect(w.rect), on_state: w.on_state.clone(), on })
                    })
                    .collect();
                FieldInfo {
                    kind: match f.kind {
                        FieldKind::Text => "text",
                        FieldKind::CheckBox => "check",
                        FieldKind::Radio => "radio",
                        FieldKind::PushButton => "button",
                        FieldKind::Combo => "combo",
                        FieldKind::List => "list",
                        FieldKind::Signature => "signature",
                    },
                    read_only: f.read_only() || f.locked(),
                    required: f.has(flags::REQUIRED),
                    multiline: f.has(flags::MULTILINE),
                    password: f.has(flags::PASSWORD),
                    many: f.has(flags::MULTI_SELECT),
                    max_len: f.max_len,
                    tooltip: f.tooltip.clone().filter(|t| !t.is_empty()),
                    options: f.options.clone(),
                    value: f.value.clone(),
                    name: f.name,
                    widgets,
                }
            })
            .collect()
    }

    /// Set a field. Every page that shows a field is to be drawn again (one field may be worked
    /// out from another).
    pub fn set_field(&mut self, name: &str, value: Value) -> Result<Change, Fail> {
        let value = match value {
            Value::Text(t) => FieldValue::Text(t),
            Value::Check(on) => FieldValue::Check(on),
            Value::Radio(which) => FieldValue::Radio(which),
            Value::Choice(list) => FieldValue::Choice(list),
        };
        self.change(Kind::Forms, |doc| Ok(wfpdf_forms::set_value(doc, name, &value)?))?;
        let mut pages: Vec<usize> = wfpdf_forms::fields(self.document()).iter().flat_map(|f| f.widgets.iter().filter_map(|w| w.page)).collect();
        pages.sort_unstable();
        pages.dedup();
        Ok(Change { changed_pages: pages, structure_changed: false })
    }

    /// Make what was filled in and signed part of the pages themselves (all pages when none are
    /// named): it can then no longer be moved or taken off. Returns how many things that was.
    pub fn flatten_fill_sign(&mut self, pages: &[usize]) -> Result<(usize, Change), Fail> {
        let all: Vec<usize> = if pages.is_empty() { (0..self.page_count()).collect() } else { pages.to_vec() };
        let count = self.change(Kind::Forms, |doc| Ok(wfpdf_edit::flatten_fill_sign(doc, &all)?))?;
        Ok((count, Change { changed_pages: all, structure_changed: false }))
    }
}
