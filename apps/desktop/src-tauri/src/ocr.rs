//! Reading the text in a picture of a page.
//!
//! A scanned PDF holds pictures of pages and none of their text. To import
//! one as a document the text has to be read out of the pictures, which is
//! work the system already knows how to do: on a Mac, an iPhone or an iPad
//! its own recogniser (Vision) is used, on this device, with nothing sent
//! anywhere. Other systems say they have none (`ocr_status` is false), and
//! the importer keeps such pages as pictures.
//!
//! In: one picture (PNG or JPEG bytes, raw). Out: the lines of text found,
//! each with its place as parts of the picture, measured from its top left.

use serde::Serialize;

use crate::commands::connect::CmdError;

/// Largest picture read.
const MAX_PICTURE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct OcrLine {
    pub text: String,
    /// The line's box: left, top, width and height, each from 0 to 1.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// How sure the recogniser is, from 0 to 1.
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrPage {
    pub lines: Vec<OcrLine>,
}

/// Whether this system can read text out of a picture.
#[tauri::command]
pub fn ocr_status() -> bool {
    cfg!(any(target_os = "macos", target_os = "ios"))
}

#[tauri::command]
pub async fn ocr_page(request: tauri::ipc::Request<'_>) -> Result<OcrPage, CmdError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new(
            "bad_body",
            "expected the picture's raw bytes",
        ));
    };
    if bytes.is_empty() || bytes.len() > MAX_PICTURE_BYTES {
        return Err(CmdError::new(
            "too_large",
            "the picture is too large to read",
        ));
    }
    let png = bytes.starts_with(&[0x89, b'P', b'N', b'G']);
    let jpeg = bytes.starts_with(&[0xff, 0xd8, 0xff]);
    if !png && !jpeg {
        return Err(CmdError::new("bad_body", "not a PNG or a JPEG"));
    }
    let lang = request
        .headers()
        .get("x-lang")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = bytes.clone();
    // Reading a page takes a second or so: off the thread that answers
    // everything else.
    let lines = tokio::task::spawn_blocking(move || read(&bytes, &lang))
        .await
        .map_err(|e| CmdError::new("ocr_failed", format!("the reading stopped: {e}")))?
        .map_err(|e| CmdError::new("ocr_failed", e))?;
    Ok(OcrPage { lines })
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn read(_bytes: &[u8], _lang: &str) -> Result<Vec<OcrLine>, String> {
    Err("this system has no text recogniser the app can use".into())
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub use apple::read;

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSData, NSRect, NSString};

    use super::OcrLine;

    // Linking Vision is what makes its classes exist.
    #[link(name = "Vision", kind = "framework")]
    extern "C" {}

    /// `VNRequestTextRecognitionLevelAccurate`.
    const ACCURATE: isize = 0;

    /// The language to read in, as the recogniser names it: the one asked
    /// for when it knows it (by its whole tag, else by its first part),
    /// otherwise none, and it reads in its own first language.
    unsafe fn language(request: *mut AnyObject, asked: &str) -> Option<String> {
        if asked.is_empty() {
            return None;
        }
        let known: *mut AnyObject = msg_send![
            request,
            supportedRecognitionLanguagesAndReturnError: std::ptr::null_mut::<*mut AnyObject>()
        ];
        if known.is_null() {
            return None;
        }
        let count: usize = msg_send![known, count];
        let short = asked.split('-').next().unwrap_or(asked).to_lowercase();
        let mut near: Option<String> = None;
        for i in 0..count {
            let item: *mut NSString = msg_send![known, objectAtIndex: i];
            if item.is_null() {
                continue;
            }
            let tag = (*item).to_string();
            if tag.eq_ignore_ascii_case(asked) {
                return Some(tag);
            }
            if near.is_none() && tag.split('-').next().unwrap_or("").to_lowercase() == short {
                near = Some(tag);
            }
        }
        near
    }

    /// Read the text in a picture. Blocks until it is read.
    pub fn read(bytes: &[u8], lang: &str) -> Result<Vec<OcrLine>, String> {
        let handler_class =
            AnyClass::get(c"VNImageRequestHandler").ok_or("Vision is not available")?;
        let request_class =
            AnyClass::get(c"VNRecognizeTextRequest").ok_or("Vision is not available")?;
        let array_class = AnyClass::get(c"NSArray").ok_or("Foundation is not available")?;
        let dictionary_class =
            AnyClass::get(c"NSDictionary").ok_or("Foundation is not available")?;
        let data = NSData::with_bytes(bytes);
        autoreleasepool(|_| {
            // SAFETY: plain Vision and Foundation messages with their
            // documented argument types. The two objects made here (`alloc`)
            // are released below; everything else is autoreleased into the
            // pool this runs in.
            unsafe {
                let options: *mut AnyObject = msg_send![dictionary_class, dictionary];
                let handler: *mut AnyObject = msg_send![handler_class, alloc];
                let handler: *mut AnyObject =
                    msg_send![handler, initWithData: &*data, options: options];
                if handler.is_null() {
                    return Err("the picture could not be opened".to_string());
                }
                let request: *mut AnyObject = msg_send![request_class, alloc];
                let request: *mut AnyObject = msg_send![request, init];
                if request.is_null() {
                    let _: () = msg_send![handler, release];
                    return Err("no text recogniser".to_string());
                }
                let _: () = msg_send![request, setRecognitionLevel: ACCURATE];
                let _: () = msg_send![request, setUsesLanguageCorrection: true];
                if let Some(tag) = language(request, lang) {
                    let tag = NSString::from_str(&tag);
                    let languages: *mut AnyObject = msg_send![array_class, arrayWithObject: &*tag];
                    let _: () = msg_send![request, setRecognitionLanguages: languages];
                }
                let requests: *mut AnyObject = msg_send![array_class, arrayWithObject: request];
                let mut error: *mut AnyObject = std::ptr::null_mut();
                let done: bool = msg_send![handler, performRequests: requests, error: &mut error];
                let outcome = if done {
                    let results: *mut AnyObject = msg_send![request, results];
                    let count: usize = if results.is_null() {
                        0
                    } else {
                        msg_send![results, count]
                    };
                    let mut lines = Vec::with_capacity(count);
                    for i in 0..count {
                        let seen: *mut AnyObject = msg_send![results, objectAtIndex: i];
                        let candidates: *mut AnyObject = msg_send![seen, topCandidates: 1usize];
                        let have: usize = if candidates.is_null() {
                            0
                        } else {
                            msg_send![candidates, count]
                        };
                        if have == 0 {
                            continue;
                        }
                        let best: *mut AnyObject = msg_send![candidates, objectAtIndex: 0usize];
                        let string: *mut NSString = msg_send![best, string];
                        if string.is_null() {
                            continue;
                        }
                        let confidence: f32 = msg_send![best, confidence];
                        // (Vision measures from the bottom left.)
                        let b: NSRect = msg_send![seen, boundingBox];
                        lines.push(OcrLine {
                            text: (*string).to_string(),
                            x: b.origin.x,
                            y: 1.0 - b.origin.y - b.size.height,
                            w: b.size.width,
                            h: b.size.height,
                            confidence,
                        });
                    }
                    Ok(lines)
                } else {
                    Err("the picture could not be read".to_string())
                };
                let _: () = msg_send![request, release];
                let _: () = msg_send![handler, release];
                outcome
            }
        })
    }
}
