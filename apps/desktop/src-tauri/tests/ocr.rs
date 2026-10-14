//! The system's text recogniser, on a picture of a page of this app's own
//! typesetting (tests/fixtures/ocr-page.png: a heading and four lines).

#![cfg(target_os = "macos")]

use writform_desktop_lib::ocr;

const PAGE: &[u8] = include_bytes!("fixtures/ocr-page.png");

#[test]
fn a_picture_of_a_page_is_read_line_by_line() {
    let lines = ocr::read(PAGE, "en-GB").expect("the picture is read");
    let text = lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(lines.len() >= 5, "five lines or more: {text}");
    assert!(text.contains("The Harbour"), "the heading: {text}");
    assert!(
        text.contains("It was a bright cold day"),
        "the first line: {text}"
    );
    assert!(
        text.contains("nobody on the quay looked up"),
        "a line of the paragraph: {text}"
    );

    // Each line has a place on the picture, measured from its top left:
    // the heading above the text, everything inside the picture.
    let heading = lines
        .iter()
        .find(|line| line.text.contains("The Harbour"))
        .expect("the heading");
    let first = lines
        .iter()
        .find(|line| line.text.contains("bright"))
        .expect("the first line");
    assert!(heading.y < first.y, "the heading stands above the text");
    assert!(heading.h > first.h, "and is set larger");
    for line in &lines {
        assert!(
            line.x >= 0.0 && line.y >= 0.0 && line.x + line.w <= 1.001 && line.y + line.h <= 1.001
        );
        assert!(line.confidence > 0.3, "sure enough of: {}", line.text);
    }
}

#[test]
fn what_is_not_a_picture_is_refused() {
    assert!(ocr::read(b"not a picture at all", "en-US").is_err());
}

#[test]
fn a_language_nobody_reads_in_is_no_obstacle() {
    let lines = ocr::read(PAGE, "xx-XX").expect("read in the recogniser's own first language");
    assert!(lines.iter().any(|line| line.text.contains("Harbour")));
}
