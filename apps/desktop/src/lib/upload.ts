import { attachmentRef, backend, localDocMediaUrl, type ApiResponse, type CmdError } from "./backend";

/** Attachment metadata returned by POST /api/v1/attachments. */
export interface UploadedAttachment {
  id: number;
  original_name: string | null;
}

function unwrap(res: ApiResponse): UploadedAttachment {
  if (res.status >= 400) {
    const err = (res.body ?? {}) as Partial<CmdError>;
    throw {
      code: err.code ?? "upload_failed",
      message: err.message ?? `upload failed (${res.status})`,
    } satisfies CmdError;
  }
  return res.body as UploadedAttachment;
}

/** Upload in-memory bytes (paste, HTML5 drop, file picker). */
export async function uploadBlob(blob: Blob, fileName: string): Promise<UploadedAttachment> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return unwrap(await backend.uploadAttachment({ dataBase64: btoa(binary), fileName }));
}

/** Upload a file by filesystem path (native drag & drop via Tauri). */
export async function uploadPath(filePath: string): Promise<UploadedAttachment> {
  return unwrap(await backend.uploadAttachment({ filePath }));
}

/** Where a picture being added to a document goes: resolves to the `src`
 *  the image node stores. */
export type ImageUploader = (file: File) => Promise<string>;

/** The most a picture may weigh where each kind of document keeps its
 *  pictures (the server's attachments, the device's own store). */
export const SERVER_PICTURE_BYTES = 10 * 1024 * 1024;
export const DEVICE_PICTURE_BYTES = 24 * 1024 * 1024;

/** A server document's pictures are attachments on its server. */
export const uploadToServer: ImageUploader = async (file) => attachmentRef((await uploadBlob(file, file.name)).id);

// The kinds every export can carry (PDF and Word take no others).
const LOCAL_IMAGE = /^image\/(png|jpeg|gif)$/;

/** An on-device document's pictures are stored beside it, on this device. */
export function uploadToDevice(docId: string): ImageUploader {
  return async (file) => {
    if (!LOCAL_IMAGE.test(file.type)) {
      throw { code: "bad_image", message: "That kind of picture can’t be added. Use a PNG, JPEG or GIF." } satisfies CmdError;
    }
    const mediaId = crypto.randomUUID();
    await backend.localdocMediaWrite(docId, mediaId, await file.arrayBuffer());
    return localDocMediaUrl(docId, mediaId);
  };
}
