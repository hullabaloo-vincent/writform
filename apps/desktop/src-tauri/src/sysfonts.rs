//! Fonts installed on this computer.
//!
//! The picker lists them; the screen draws them by name (the webview already
//! can); and the page layout reads their files so a PDF or a printout is set
//! in the very same font — but only where the font says it may be embedded.
//! A font marked "restricted" (or "no subsetting") stays on screen and is
//! substituted in the PDF, with a note. Nothing here is ever uploaded.
//!
//! Desktop only: iOS doesn't let an app read the system's font files.

use std::sync::OnceLock;

use serde::Serialize;

use crate::commands::connect::CmdError;

/// A font file larger than this isn't read (some CJK collections are 100 MB).
const MAX_FONT_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Default)]
pub struct SysFonts(OnceLock<fontdb::Database>);

impl SysFonts {
    /// Scanning the system's font folders takes a moment; it happens once,
    /// the first time anything asks.
    fn db(&self) -> &fontdb::Database {
        self.0.get_or_init(|| {
            let mut db = fontdb::Database::new();
            db.load_system_fonts();
            db
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SysFamily {
    pub family: String,
    /// Which of `regular`, `italic`, `bold`, `boldItalic` it has.
    pub styles: Vec<&'static str>,
    pub monospace: bool,
}

fn is_bold(face: &fontdb::FaceInfo) -> bool {
    face.weight.0 >= 600
}

fn is_italic(face: &fontdb::FaceInfo) -> bool {
    face.style != fontdb::Style::Normal
}

fn style_name(bold: bool, italic: bool) -> &'static str {
    match (bold, italic) {
        (false, false) => "regular",
        (false, true) => "italic",
        (true, false) => "bold",
        (true, true) => "boldItalic",
    }
}

/// Every installed family, by its (first) name, with the styles it has.
pub fn list_families(db: &fontdb::Database) -> Vec<SysFamily> {
    let mut by_name: std::collections::BTreeMap<String, SysFamily> =
        std::collections::BTreeMap::new();
    for face in db.faces() {
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        // Names starting with a dot are the system's own interface fonts,
        // which only the system may use.
        if name.is_empty() || name.starts_with('.') || name.len() > 80 {
            continue;
        }
        let entry = by_name
            .entry(name.to_lowercase())
            .or_insert_with(|| SysFamily {
                family: name.clone(),
                styles: Vec::new(),
                monospace: face.monospaced,
            });
        let style = style_name(is_bold(face), is_italic(face));
        if !entry.styles.contains(&style) {
            entry.styles.push(style);
        }
    }
    let mut out: Vec<SysFamily> = by_name.into_values().collect();
    out.sort_by_key(|a| a.family.to_lowercase());
    out
}

/// The face of `family` nearest the style asked for — exactly that style,
/// or nothing (the layout slants or thickens a roman itself, and says so).
pub fn pick_face(
    db: &fontdb::Database,
    family: &str,
    bold: bool,
    italic: bool,
) -> Option<fontdb::ID> {
    let want = if bold { 700i32 } else { 400i32 };
    db.faces()
        .filter(|f| {
            f.families
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(family))
        })
        .filter(|f| is_bold(f) == bold && is_italic(f) == italic)
        .min_by_key(|f| {
            let stretch = if f.stretch == fontdb::Stretch::Normal {
                0
            } else {
                1000
            };
            stretch + (i32::from(f.weight.0) - want).abs()
        })
        .map(|f| f.id)
}

/// Whether a font's own licence bits let it be embedded (subsetted) in a
/// document. Unreadable fonts are treated as "no".
pub fn may_embed(data: &[u8], index: u32) -> bool {
    let Ok(face) = ttf_parser::Face::parse(data, index) else {
        return false;
    };
    let allowed = !matches!(
        face.permissions(),
        Some(ttf_parser::Permissions::Restricted)
    );
    allowed && face.is_subsetting_allowed()
}

#[tauri::command(async)]
pub fn sysfont_list(fonts: tauri::State<'_, SysFonts>) -> Vec<SysFamily> {
    list_families(fonts.db())
}

/// One face's file, for embedding: four bytes of face index (little-endian;
/// a collection file holds several faces) and then the file's bytes.
///
/// Errors: `not_found` (no such family or style), `not_embeddable` (its
/// licence says no), `too_large`.
#[tauri::command(async)]
pub fn sysfont_bytes(
    fonts: tauri::State<'_, SysFonts>,
    family: String,
    bold: bool,
    italic: bool,
) -> Result<tauri::ipc::Response, CmdError> {
    let db = fonts.db();
    let id = pick_face(db, &family, bold, italic)
        .ok_or_else(|| CmdError::new("not_found", "no such font on this computer"))?;
    let out = db
        .with_face_data(id, |data, index| {
            if data.len() as u64 > MAX_FONT_BYTES {
                return Err(CmdError::new(
                    "too_large",
                    "that font file is too large to embed",
                ));
            }
            if !may_embed(data, index) {
                return Err(CmdError::new(
                    "not_embeddable",
                    "that font's licence doesn't allow embedding it in a document",
                ));
            }
            let mut out = Vec::with_capacity(data.len() + 4);
            out.extend_from_slice(&index.to_le_bytes());
            out.extend_from_slice(data);
            Ok(out)
        })
        .ok_or_else(|| CmdError::new("not_found", "that font's file couldn't be read"))??;
    Ok(tauri::ipc::Response::new(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled(name: &str) -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/assets/fonts")
            .join(name);
        std::fs::read(path).unwrap()
    }

    #[test]
    fn families_list_their_styles_and_faces_are_found_by_style() {
        let mut db = fontdb::Database::new();
        for file in [
            "carlito/Carlito-Regular.ttf",
            "carlito/Carlito-Italic.ttf",
            "carlito/Carlito-Bold.ttf",
            "carlito/Carlito-BoldItalic.ttf",
            "cinzel/Cinzel[wght].ttf",
        ] {
            db.load_font_data(bundled(file));
        }
        let list = list_families(&db);
        let carlito = list.iter().find(|f| f.family == "Carlito").unwrap();
        let mut styles = carlito.styles.clone();
        styles.sort_unstable();
        assert_eq!(styles, ["bold", "boldItalic", "italic", "regular"]);
        assert!(!carlito.monospace);
        assert_eq!(
            list.iter().find(|f| f.family == "Cinzel").unwrap().styles,
            ["regular"]
        );

        // By name, whatever its case; the style asked for or nothing.
        assert!(pick_face(&db, "carlito", true, true).is_some());
        assert!(pick_face(&db, "CARLITO", false, false).is_some());
        assert!(pick_face(&db, "Cinzel", false, true).is_none());
        assert!(pick_face(&db, "No Such Font", false, false).is_none());

        let bold = db
            .face(pick_face(&db, "Carlito", true, false).unwrap())
            .unwrap();
        assert!(bold.weight.0 >= 600 && bold.style == fontdb::Style::Normal);
    }

    #[test]
    fn a_fonts_own_licence_bits_decide_embedding() {
        // Carlito is OFL: installable, subsetting allowed.
        let mut data = bundled("carlito/Carlito-Regular.ttf");
        assert!(may_embed(&data, 0));
        assert!(!may_embed(b"not a font", 0));

        // Flip its OS/2 fsType to "restricted licence embedding" (bit 1).
        let face = ttf_parser::RawFace::parse(&data, 0).unwrap();
        let os2 = face.table(ttf_parser::Tag::from_bytes(b"OS/2")).unwrap();
        let offset = os2.as_ptr() as usize - data.as_ptr() as usize;
        data[offset + 8] = 0x00;
        data[offset + 9] = 0x02;
        assert!(!may_embed(&data, 0));
        // "No subsetting" (bit 8) rules it out too: the PDF writer subsets.
        data[offset + 8] = 0x01;
        data[offset + 9] = 0x00;
        assert!(!may_embed(&data, 0));
    }
}
