import { backend, type ApiResponse, type CmdError } from "./backend";

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
