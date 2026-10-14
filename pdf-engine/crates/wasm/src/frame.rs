//! Where things are on a page, as the app says it and as the engine does.
//!
//! The app measures a page the way it is looked at: points, from the top left corner of the page
//! as shown, x to the right and y down. The engine has two spaces of its own: display space (as
//! shown, but from the bottom left, y up), which added text and pictures are placed in, and user
//! space (the page's own, before it is turned or cropped), which annotations, form fields and a
//! page's existing text are in. A `Frame` is one page's way between the three.

use wfpdf_cos::Document;

use crate::session::Fail;

pub struct Frame {
    /// Display space to user space.
    m: [f64; 6],
    /// How tall the page is as shown.
    h: f64,
}

impl Frame {
    pub fn of(doc: &Document, page: usize) -> Result<Self, Fail> {
        let pages = wfpdf_model::pages(doc);
        let p = pages.get(page).ok_or_else(|| Fail::invalid(format!("there is no page {}", page + 1)))?;
        Ok(Self { m: p.view_matrix(doc), h: p.display_size(doc).1 })
    }

    /// A point as the app has it, in user space.
    pub fn user(&self, p: [f64; 2]) -> [f64; 2] {
        let (x, y) = (p[0], self.h - p[1]);
        let m = self.m;
        [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
    }

    /// A point of user space, as the app has it.
    pub fn view(&self, p: [f64; 2]) -> [f64; 2] {
        let m = self.m;
        let det = m[0] * m[3] - m[1] * m[2];
        if det.abs() < 1e-12 {
            return [0.0, 0.0];
        }
        let (dx, dy) = (p[0] - m[4], p[1] - m[5]);
        let x = (m[3] * dx - m[2] * dy) / det;
        let y = (m[0] * dy - m[1] * dx) / det;
        [x, self.h - y]
    }

    /// A step as the app has it (so far right, so far down), in user space.
    pub fn user_step(&self, d: [f64; 2]) -> [f64; 2] {
        let m = self.m;
        let (x, y) = (d[0], -d[1]);
        [m[0] * x + m[2] * y, m[1] * x + m[3] * y]
    }

    /// A box as the app has it (`[x, y, width, height]`), as a rectangle of user space
    /// (`[x0, y0, x1, y1]`, lowest first).
    pub fn user_rect(&self, r: [f64; 4]) -> [f64; 4] {
        let a = self.user([r[0], r[1]]);
        let b = self.user([r[0] + r[2], r[1] + r[3]]);
        [a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1])]
    }

    /// A rectangle of user space as the app's box.
    pub fn view_rect(&self, r: [f64; 4]) -> [f64; 4] {
        let a = self.view([r[0], r[1]]);
        let b = self.view([r[2], r[3]]);
        [a[0].min(b[0]), a[1].min(b[1]), (a[0] - b[0]).abs(), (a[1] - b[1]).abs()]
    }

    /// A box as the app has it, as a rectangle of display space.
    pub fn display_rect(&self, r: [f64; 4]) -> [f64; 4] {
        [r[0], self.h - r[1] - r[3], r[0] + r[2], self.h - r[1]]
    }

    /// A rectangle of display space as the app's box.
    pub fn view_of_display(&self, r: [f64; 4]) -> [f64; 4] {
        [r[0].min(r[2]), self.h - r[1].max(r[3]), (r[2] - r[0]).abs(), (r[3] - r[1]).abs()]
    }

    /// A box as the app has it, as the four corners a text markup is made of: top left, top
    /// right, bottom left, bottom right, as the text reads.
    pub fn quad(&self, r: [f64; 4]) -> [f64; 8] {
        let tl = self.user([r[0], r[1]]);
        let tr = self.user([r[0] + r[2], r[1]]);
        let bl = self.user([r[0], r[1] + r[3]]);
        let br = self.user([r[0] + r[2], r[1] + r[3]]);
        [tl[0], tl[1], tr[0], tr[1], bl[0], bl[1], br[0], br[1]]
    }
}
