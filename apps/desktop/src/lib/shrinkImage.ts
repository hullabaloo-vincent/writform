/**
 * A picture chosen for a profile, made no larger than it needs to be: a
 * phone photo is many megabytes and thousands of pixels across, and an
 * avatar is drawn a few dozen wide. Drawn onto a canvas at most `maxSide`
 * on its longer side and re-encoded (PNG keeps transparency; JPEG for
 * photographs). A small picture — and an animated GIF, which a canvas would
 * freeze — goes through as it is.
 */
export async function shrinkImage(file: Blob, maxSide: number, kind: "png" | "jpeg"): Promise<Blob> {
  if (file.type === "image/gif" && file.size <= 2 * 1024 * 1024) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const usable = /^image\/(png|jpeg|webp)$/.test(file.type);
    if (scale === 1 && usable && file.size <= 1024 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    if (kind === "jpeg") {
      // JPEG has no transparency: see-through parts would come out black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, kind === "png" ? "image/png" : "image/jpeg", 0.9),
    );
    return blob ?? file;
  } catch {
    // Not something this webview can draw: let the store say why.
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}
