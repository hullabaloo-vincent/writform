import type { Editor } from "@tiptap/react";
import { Pause, Play, SkipBack, SkipForward, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { RATES, ReadAloud, voicesFor, type ReadAloudState, type Voice } from "./readAloud";

/**
 * The read-aloud controls: play and pause, a sentence back or on, how fast,
 * which voice. Opens reading from where the caret is.
 */
export function ReadAloudBar({ editor, lang, onClose }: { editor: Editor; lang: string; onClose: () => void }) {
  const [state, setState] = useState<ReadAloudState>({ status: "idle", rate: 1, voice: null });
  const reader = useMemo(() => new ReadAloud(editor, lang, setState), [editor, lang]);
  const [voices, setVoices] = useState<Voice[]>(() => voicesFor(lang));

  useEffect(() => {
    setState(reader.current);
    // Opening the bar is the request to read (and the tap that lets a
    // phone speak).
    reader.play();
    return () => reader.destroy();
  }, [reader]);

  // Some systems list their voices a moment after the first ask.
  useEffect(() => {
    const engine = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!engine?.addEventListener) return;
    const update = () => setVoices(voicesFor(lang));
    update();
    engine.addEventListener("voiceschanged", update);
    return () => engine.removeEventListener("voiceschanged", update);
  }, [lang]);

  const playing = state.status === "playing";
  return (
    <div className="wf-find-bar wf-read-bar" role="group" aria-label="Read aloud">
      <button className="wf-icon" title={playing ? "Pause" : "Read from here"} onClick={() => (playing ? reader.pause() : reader.play())}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button className="wf-icon" title="Back a sentence" onClick={() => reader.step(-1)}>
        <SkipBack size={15} />
      </button>
      <button className="wf-icon" title="On a sentence" onClick={() => reader.step(1)}>
        <SkipForward size={15} />
      </button>
      <button className="wf-icon" title="Stop" disabled={state.status === "idle"} onClick={() => reader.stop()}>
        <Square size={14} />
      </button>
      <select className="wf-read-rate" title="Speed" aria-label="Speed" value={state.rate} onChange={(e) => reader.setRate(Number(e.target.value))}>
        {RATES.map((rate) => (
          <option key={rate} value={rate}>
            {rate}×
          </option>
        ))}
      </select>
      {voices.length > 1 && (
        <select className="wf-read-voice" title="Voice" aria-label="Voice" value={state.voice ?? ""} onChange={(e) => reader.setVoice(e.target.value || null)}>
          <option value="">System voice</option>
          {voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
            </option>
          ))}
        </select>
      )}
      <span className="wf-read-status">{state.status === "idle" ? "Put the caret where to start, then press play." : playing ? "Reading…" : "Paused"}</span>
      <span className="wf-statusbar-spacer" />
      <button className="wf-icon" title="Close" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}
