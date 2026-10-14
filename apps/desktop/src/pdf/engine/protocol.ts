/** What goes between the page and the worker the PDF engine runs in. */

import type { EngineCall, EngineCalls, EngineChange, EngineFail, EngineInfo, EngineRead, EngineReads } from "./core";

export type EngineRequest =
  | { op: "open"; bytes: Uint8Array; password?: string }
  | { op: "info" }
  | { op: "call"; method: EngineCall; args: EngineCalls[EngineCall] }
  | { op: "read"; what: EngineRead; args: EngineReads[EngineRead]["args"] }
  | { op: "bytes"; full: boolean }
  | { op: "extract"; pages: number[] }
  | { op: "saved"; bytes: Uint8Array }
  | { op: "close" };

export type EngineAnswer = EngineInfo | EngineChange | Uint8Array | EngineReads[EngineRead]["value"] | null;

export type EngineReply = { id: number; ok: true; value: EngineAnswer } | { id: number; ok: false; fail: EngineFail } | { ready: true } | { ready: false; message: string };
