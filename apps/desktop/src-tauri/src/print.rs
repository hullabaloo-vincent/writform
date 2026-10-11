//! Printing a finished PDF.
//!
//! The app typesets its own pages, so printing is handing a PDF to the
//! system: on macOS the native print panel (PDFKit's print operation), on
//! an iPhone the system print sheet. Where there is no native way in — or
//! it fails — the PDF is opened in the system's viewer instead, and the
//! frontend falls back to the webview's own printing or the share sheet.
//!
//! The outcome goes back as a word:
//! `printed` / `cancelled` (macOS panel), `presented` (iOS sheet is up),
//! `opened` (in the system viewer), or `frame` (print it in the webview).

use crate::commands::api::{export_file_name, percent_decode};
use crate::commands::connect::CmdError;

/// Largest PDF handed over (the same ceiling as saving a file).
const MAX_PRINT_BYTES: usize = 256 * 1024 * 1024;

#[tauri::command]
pub async fn print_pdf(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<&'static str, CmdError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new("bad_body", "expected the PDF's raw bytes"));
    };
    if bytes.len() > MAX_PRINT_BYTES {
        return Err(CmdError::new(
            "too_large",
            "the document is too large to print",
        ));
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(CmdError::new("bad_body", "not a PDF"));
    }
    let title = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    let name = export_file_name(&title, "pdf");

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        // AppKit and UIKit are main-thread only.
        let (tx, rx) = tokio::sync::oneshot::channel();
        let data = bytes.clone();
        let job = name.trim_end_matches(".pdf").to_string();
        let dispatched = app.run_on_main_thread(move || {
            let _ = tx.send(native::print(&data, &job));
        });
        if dispatched.is_ok() {
            match rx.await {
                Ok(Ok(outcome)) => return Ok(outcome),
                Ok(Err(reason)) => tracing::warn!("native print unavailable: {reason}"),
                Err(_) => tracing::warn!("native print never answered"),
            }
        }
    }

    fallback(&app, bytes, &name).await
}

/// WebView2 prints PDFs itself: the frontend does it in a frame.
#[cfg(target_os = "windows")]
async fn fallback(
    _app: &tauri::AppHandle,
    _bytes: &[u8],
    _name: &str,
) -> Result<&'static str, CmdError> {
    Ok("frame")
}

/// A phone has no viewer to hand off to: the frontend offers the share
/// sheet, which prints.
#[cfg(mobile)]
async fn fallback(
    _app: &tauri::AppHandle,
    _bytes: &[u8],
    _name: &str,
) -> Result<&'static str, CmdError> {
    Err(CmdError::new(
        "print_unavailable",
        "printing isn't available here",
    ))
}

#[cfg(all(desktop, not(target_os = "windows")))]
async fn fallback(
    app: &tauri::AppHandle,
    bytes: &[u8],
    name: &str,
) -> Result<&'static str, CmdError> {
    open_in_viewer(app, bytes, name).await?;
    Ok("opened")
}

/// Write the PDF to a temporary file and open it in the default viewer,
/// which can print it.
#[cfg(all(desktop, not(target_os = "windows")))]
async fn open_in_viewer(app: &tauri::AppHandle, bytes: &[u8], name: &str) -> Result<(), CmdError> {
    use tauri_plugin_opener::OpenerExt;

    let dir = std::env::temp_dir().join("subScribe-print");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| CmdError::new("write_failed", format!("could not prepare the file: {e}")))?;
    let path = dir.join(name);
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| CmdError::new("write_failed", format!("could not prepare the file: {e}")))?;
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| CmdError::new("open_failed", format!("could not open the PDF: {e}")))
}

#[cfg(target_os = "macos")]
mod native {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSData, NSString};

    // PDFKit lives in Quartz; linking it is what makes `PDFDocument` exist.
    #[link(name = "Quartz", kind = "framework")]
    extern "C" {}

    /// `kPDFPrintPageScaleDownToFit`: never enlarge, never crop.
    const SCALE_DOWN_TO_FIT: isize = 2;

    /// Run the print panel for the PDF. Blocks (it's modal) until the panel
    /// is closed; main thread only.
    pub fn print(bytes: &[u8], job: &str) -> Result<&'static str, String> {
        let pdf_class = AnyClass::get(c"PDFDocument").ok_or("PDFKit is not available")?;
        let info_class = AnyClass::get(c"NSPrintInfo").ok_or("AppKit is not available")?;
        let data = NSData::with_bytes(bytes);
        // SAFETY: plain AppKit/PDFKit messages with their documented
        // argument types, on the main thread. Objects we create (`alloc`,
        // `copy`) are released below; the print operation is autoreleased.
        unsafe {
            let doc: *mut AnyObject = msg_send![pdf_class, alloc];
            let doc: *mut AnyObject = msg_send![doc, initWithData: &*data];
            if doc.is_null() {
                return Err("the PDF could not be read".into());
            }
            let shared: *mut AnyObject = msg_send![info_class, sharedPrintInfo];
            let info: *mut AnyObject = msg_send![shared, copy];
            // The pages carry their own margins.
            let _: () = msg_send![info, setTopMargin: 0.0f64];
            let _: () = msg_send![info, setBottomMargin: 0.0f64];
            let _: () = msg_send![info, setLeftMargin: 0.0f64];
            let _: () = msg_send![info, setRightMargin: 0.0f64];
            let _: () = msg_send![info, setHorizontallyCentered: true];
            let _: () = msg_send![info, setVerticallyCentered: true];
            let operation: *mut AnyObject = msg_send![
                doc,
                printOperationForPrintInfo: info,
                scalingMode: SCALE_DOWN_TO_FIT,
                autoRotate: true
            ];
            let outcome = if operation.is_null() {
                Err("no print operation".to_string())
            } else {
                let title = NSString::from_str(job);
                let _: () = msg_send![operation, setJobTitle: &*title];
                let ran: bool = msg_send![operation, runOperation];
                Ok(if ran { "printed" } else { "cancelled" })
            };
            let _: () = msg_send![info, release];
            let _: () = msg_send![doc, release];
            outcome
        }
    }
}

#[cfg(target_os = "ios")]
mod native {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSData, NSString};

    /// `UIUserInterfaceIdiomPhone`.
    const IDIOM_PHONE: isize = 0;

    /// Put the system print sheet up for the PDF. Returns at once; the
    /// sheet is the system's from there. Main thread only.
    pub fn print(bytes: &[u8], job: &str) -> Result<&'static str, String> {
        let controller_class = AnyClass::get(c"UIPrintInteractionController")
            .ok_or("UIKit printing is not available")?;
        let info_class = AnyClass::get(c"UIPrintInfo").ok_or("UIKit printing is not available")?;
        let device_class = AnyClass::get(c"UIDevice").ok_or("UIKit is not available")?;
        let data = NSData::with_bytes(bytes);
        // SAFETY: plain UIKit messages with their documented argument
        // types, on the main thread; nothing here is owned by us.
        unsafe {
            // The sheet presents itself only on an iPhone; an iPad needs a
            // place to anchor it, which the share sheet handles instead.
            let device: *mut AnyObject = msg_send![device_class, currentDevice];
            let idiom: isize = msg_send![device, userInterfaceIdiom];
            if idiom != IDIOM_PHONE {
                return Err("not an iPhone".into());
            }
            let available: bool = msg_send![controller_class, isPrintingAvailable];
            let printable: bool = msg_send![controller_class, canPrintData: &*data];
            if !available || !printable {
                return Err("printing is not available".into());
            }
            let controller: *mut AnyObject = msg_send![controller_class, sharedPrintController];
            let info: *mut AnyObject = msg_send![info_class, printInfo];
            let title = NSString::from_str(job);
            let _: () = msg_send![info, setJobName: &*title];
            let _: () = msg_send![controller, setPrintInfo: info];
            let _: () = msg_send![controller, setPrintingItem: &*data];
            let handler: Option<&block2::Block<dyn Fn(*mut AnyObject, Bool, *mut AnyObject)>> =
                None;
            let shown: bool =
                msg_send![controller, presentAnimated: true, completionHandler: handler];
            if shown {
                Ok("presented")
            } else {
                Err("the print sheet did not open".into())
            }
        }
    }
}
