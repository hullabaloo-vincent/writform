//! Bounded glyph outlines from a font handed in. (No font is built into this copy of the engine:
//! the typed-signature faces of the original are left out.)

use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, GlyphId, MetadataProvider};

/// One glyph outline in em units, with the baseline at y = 0.
#[derive(Clone, Debug, PartialEq)]
pub struct GlyphOutline {
    pub contours: Vec<Vec<[f64; 2]>>,
    pub width: f64,
    pub bbox: [f64; 4],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlyphError {
    /// This build has no Japanese face: it was built without craft-fonts (`CRAFT_FONTS_DIR`).
    NoFont,
    Missing,
    TooComplex,
}

struct Flatten {
    contours: Vec<Vec<[f64; 2]>>,
    cur: Vec<[f64; 2]>,
    scale: f64,
    /// Horizontal shear applied to every point (x += slant × y), for slanted fallback glyphs.
    slant: f64,
    dx: f64,
    points: usize,
    too_complex: bool,
    max_points: usize,
}

impl Flatten {
    fn new(scale: f64) -> Self {
        Self { contours: Vec::new(), cur: Vec::new(), scale, slant: 0.0, dx: 0.0, points: 0, too_complex: false, max_points: 4096 }
    }

    fn pt(&self, x: f32, y: f32) -> [f64; 2] {
        let (x, y) = (x as f64 * self.scale, y as f64 * self.scale);
        [self.dx + x + self.slant * y, y]
    }

    fn last(&self) -> [f64; 2] {
        self.cur.last().copied().unwrap_or([self.dx, 0.0])
    }

    fn push(&mut self, p: [f64; 2]) {
        if self.points >= self.max_points {
            self.too_complex = true;
            return;
        }
        self.points += 1;
        self.cur.push(p);
    }

    fn close(&mut self) {
        if self.cur.len() > 2 {
            self.contours.push(std::mem::take(&mut self.cur));
        } else {
            self.cur.clear();
        }
    }
}

const STEPS: usize = 8;

impl OutlinePen for Flatten {
    fn move_to(&mut self, x: f32, y: f32) {
        self.close();
        self.push(self.pt(x, y));
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.push(self.pt(x, y));
    }

    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        let (p0, c, p) = (self.last(), self.pt(cx, cy), self.pt(x, y));
        for i in 1..=STEPS {
            let t = i as f64 / STEPS as f64;
            let u = 1.0 - t;
            self.push([u * u * p0[0] + 2.0 * u * t * c[0] + t * t * p[0], u * u * p0[1] + 2.0 * u * t * c[1] + t * t * p[1]]);
        }
    }

    fn curve_to(&mut self, c0x: f32, c0y: f32, c1x: f32, c1y: f32, x: f32, y: f32) {
        let (p0, c0, c1, p) = (self.last(), self.pt(c0x, c0y), self.pt(c1x, c1y), self.pt(x, y));
        for i in 1..=STEPS {
            let t = i as f64 / STEPS as f64;
            let u = 1.0 - t;
            let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            self.push([a * p0[0] + b * c0[0] + c * c1[0] + d * p[0], a * p0[1] + b * c0[1] + c * c1[1] + d * p[1]]);
        }
    }

    fn close(&mut self) {
        Flatten::close(self);
    }
}

/// Return one glyph of the Japanese document face ([`crate::document_japanese_font`], Shippori
/// Mincho from craft-fonts), bounded so hostile replacement text cannot allocate unbounded
/// outline data. [`GlyphError::NoFont`] when the build has no Japanese face.
pub fn japanese_glyph(ch: char) -> Result<GlyphOutline, GlyphError> {
    let Some(face) = crate::document_japanese_font() else { return Err(GlyphError::NoFont) };
    japanese_glyph_from(face, ch)
}

/// The bounded outline and advance from the explicitly selected craft-fonts face.
/// Uses the same complexity and missing-glyph checks as [`japanese_glyph`].
pub fn japanese_glyph_from(face: &crate::CraftFont, ch: char) -> Result<GlyphOutline, GlyphError> {
    let Ok(font) = FontRef::new(face.bytes) else { return Err(GlyphError::Missing) };
    let loc = LocationRef::default();
    let metrics = font.metrics(Size::unscaled(), loc);
    let scale = 1.0 / metrics.units_per_em.max(1) as f64;
    let Some(gid) = font.charmap().map(ch) else { return Err(GlyphError::Missing) };
    let advances = font.glyph_metrics(Size::unscaled(), loc);
    let width = advances.advance_width(gid).unwrap_or(0.0) as f64 * scale;
    if !width.is_finite() || width <= 0.0 || width > 2.0 {
        return Err(GlyphError::Missing);
    }
    bounded_outline(&font, gid, width)
}

/// Glyph `gid` of `font` in em units with advance `width`, bounded like [`japanese_glyph`].
pub(crate) fn bounded_outline(font: &FontRef, gid: GlyphId, width: f64) -> Result<GlyphOutline, GlyphError> {
    let loc = LocationRef::default();
    let scale = 1.0 / font.metrics(Size::unscaled(), loc).units_per_em.max(1) as f64;
    let Some(glyph) = font.outline_glyphs().get(gid) else { return Err(GlyphError::Missing) };
    let mut pen = Flatten::new(scale);
    let _ = glyph.draw(DrawSettings::unhinted(Size::unscaled(), loc), &mut pen);
    pen.close();
    if pen.too_complex || pen.contours.len() > 256 {
        return Err(GlyphError::TooComplex);
    }
    let mut bbox = [0.0, 0.0, width, 0.0];
    let mut any = false;
    for p in pen.contours.iter().flatten() {
        if !p[0].is_finite() || !p[1].is_finite() {
            return Err(GlyphError::Missing);
        }
        if !any {
            bbox = [p[0], p[1], p[0], p[1]];
            any = true;
        } else {
            bbox[0] = bbox[0].min(p[0]);
            bbox[1] = bbox[1].min(p[1]);
            bbox[2] = bbox[2].max(p[0]);
            bbox[3] = bbox[3].max(p[1]);
        }
    }
    Ok(GlyphOutline { contours: pen.contours, width, bbox })
}
