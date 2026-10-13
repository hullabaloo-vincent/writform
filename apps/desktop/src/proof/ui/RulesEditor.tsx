import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

import { saveExport } from "../../lib/saveFile";
import { toast, toastError } from "../../platform/toast";
import { CHECKS, onByDefault } from "../checks";
import { docRules, onDocRulesChange, readDocRules } from "../rules/docRules";
import { decodeRulesFile, encodeRulesFile, RULES_FILE_EXT } from "../rules/file";
import { useGlobalRules } from "../rules/globalRules";
import { VARIANTS_NOTICE } from "../data/en/variantsNotice";
import { emptyLayer, wordId, type Layer, type WordEntry } from "../rules/model";
import type { Env } from "../types";

/** The document's own rules, live. */
export function useDocLayer(ydoc: Y.Doc | null): Layer | null {
  const [layer, setLayer] = useState<Layer | null>(() => (ydoc ? readDocRules(ydoc) : null));
  useEffect(() => {
    if (!ydoc) {
      setLayer(null);
      return;
    }
    setLayer(readDocRules(ydoc));
    return onDocRulesChange(ydoc, () => setLayer(readDocRules(ydoc)));
  }, [ydoc]);
  return layer;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

type Kind = "prefer" | "look" | "allow";
const LISTS: { kind: Kind; title: string; hint: string; find: string }[] = [
  { kind: "prefer", title: "Write one for another", hint: "Each place the first is written is listed, with a fix.", find: "When you find" },
  { kind: "look", title: "Words to look at", hint: "Each place is listed for you to judge. Nothing is changed.", find: "A word or phrase" },
  { kind: "allow", title: "Never flag", hint: "No check raises a finding about these.", find: "A word or phrase" },
];

/**
 * The house style, for one of its two places: this document (shared with
 * everyone who writes it) or the writer's own rules for every document.
 */
export function RulesEditor({ scope, ydoc, canWrite, env, title }: { scope: "document" | "yours"; ydoc: Y.Doc | null; canWrite: boolean; env: Env; title: string }) {
  const yours = useGlobalRules((s) => s.layer);
  const own = useGlobalRules();
  const doc = useDocLayer(ydoc);
  const here = scope === "document";
  const layer = (here ? doc : yours) ?? emptyLayer();
  const locked = here && (!ydoc || !canWrite);
  const only = doc?.settings.only === true;
  const fileRef = useRef<HTMLInputElement>(null);

  const setOn = (check: string, value: boolean, comes: boolean) => {
    const next = value === comes ? null : value;
    if (here) {
      if (ydoc) docRules.on(ydoc, check, next);
    } else own.on(check, next);
  };
  const putWord = (entry: WordEntry | null, find?: string) => {
    if (here) {
      if (ydoc) docRules.word(ydoc, entry, find);
    } else own.word(entry, find);
  };

  const save = async () => {
    const text = encodeRulesFile(layer, title);
    await saveExport(`${title || "House style"}.${RULES_FILE_EXT}`, "wfstyle", new TextEncoder().encode(text)).catch((e: unknown) => toastError(String(e)));
  };
  const load = async (file: File) => {
    const read = decodeRulesFile(await file.text());
    if (!read) {
      toastError("That file is not a set of rules.");
      return;
    }
    if (here) {
      if (ydoc) docRules.load(ydoc, read.layer, false);
    } else own.load(read.layer, false);
    toast(`Added ${count(Object.keys(read.layer.words).length, "word rule", "word rules")} from the file.`, "success");
  };

  const aside = Object.keys(layer.never).length;
  const places = Object.keys(layer.places).length;
  const ownWords = Object.entries(yours.words);

  return (
    <div className="wf-proof-rules">
      {locked && <p className="wf-proof-dim">You can read this document’s rules and not change them.</p>}

      {here && (
        <section>
          <label className="wf-proof-tick">
            <input type="checkbox" checked={only} disabled={locked} onChange={(e) => ydoc && docRules.setting(ydoc, "only", e.target.checked ? true : null)} />
            <span>Use only this document’s rules</span>
          </label>
          <p className="wf-proof-dim">Everyone who opens it then sees the same findings. Without this, each writer’s own rules apply here too.</p>
          {ownWords.length > 0 && !locked && (
            <button
              type="button"
              className="wf-link"
              onClick={() => {
                if (ydoc) docRules.load(ydoc, { ...emptyLayer(), words: yours.words, on: yours.on }, false);
                toast("Your rules are now part of this document.", "success");
              }}
            >
              Copy my rules into this document
            </button>
          )}
        </section>
      )}

      {env.base === "en" && (
        <section>
          <h4>Spelling</h4>
          <label className="wf-proof-pick">
            <span>Spell in</span>
            <select
              value={String(layer.settings.variety ?? "")}
              disabled={locked}
              onChange={(e) => {
                const value = e.target.value || null;
                if (here) {
                  if (ydoc) docRules.setting(ydoc, "variety", value);
                } else own.setting("variety", value);
              }}
            >
              <option value="">{here && !only && yours.settings.variety ? "As in my own rules" : "Any English, so long as it is one"}</option>
              <option value="us">American</option>
              <option value="uk">British</option>
              <option value="uk-ize">British with -ize (Oxford)</option>
              <option value="ca">Canadian</option>
              <option value="au">Australian</option>
            </select>
          </label>
          <p className="wf-proof-dim">With one chosen, every spelling it does not use is listed. With none, the text is only held to whichever it mostly uses.</p>
          <label className="wf-proof-pick">
            <span>Comma before “and” in a list</span>
            <select
              value={String(layer.settings.serialComma ?? "")}
              disabled={locked}
              onChange={(e) => {
                const value = e.target.value || null;
                if (here) {
                  if (ydoc) docRules.setting(ydoc, "serialComma", value);
                } else own.setting("serialComma", value);
              }}
            >
              <option value="">Either, so long as it is one</option>
              <option value="always">Always (a, b, and c)</option>
              <option value="never">Never (a, b and c)</option>
            </select>
          </label>
        </section>
      )}

      <section>
        <h4>Checks</h4>
        {CHECKS.map((check) => {
          const comes = here ? ((only ? undefined : yours.on[check.id]) ?? onByDefault(check, env)) : onByDefault(check, env);
          const value = layer.on[check.id] ?? comes;
          return (
            <label key={check.id} className="wf-proof-tick">
              <input type="checkbox" checked={value} disabled={locked} onChange={(e) => setOn(check.id, e.target.checked, comes)} />
              <span>{check.label}</span>
            </label>
          );
        })}
      </section>

      {LISTS.map((list) => (
        <WordList key={list.kind} list={list} layer={layer} locked={locked} onPut={putWord} />
      ))}

      {here && !only && ownWords.length > 0 && (
        <section>
          <h4>Your own rules here</h4>
          <p className="wf-proof-dim">These come from your rules for all documents. Untick one to leave it out of this document.</p>
          {ownWords.map(([id, entry]) => {
            const off = doc?.words[id]?.k === "off";
            const replaced = !!doc?.words[id] && !off;
            return (
              <label key={id} className="wf-proof-tick">
                <input type="checkbox" checked={!off} disabled={locked || replaced} onChange={(e) => putWord(e.target.checked ? null : { k: "off", find: entry.find }, entry.find)} />
                <span>{entry.k === "prefer" ? `${entry.find} to ${entry.use}` : entry.find}</span>
              </label>
            );
          })}
        </section>
      )}

      <section>
        <h4>Set aside</h4>
        <p className="wf-proof-dim">
          {here
            ? aside + places === 0
              ? "Nothing is set aside in this document."
              : `${count(places, "place", "places")} and ${count(aside, "finding", "findings")} are set aside in this document.`
            : aside === 0
              ? "No finding is set aside in all your documents."
              : `${count(aside, "finding is", "findings are")} never raised in your documents.`}
        </p>
        {aside + places > 0 && !locked && (
          <button
            type="button"
            className="wf-link"
            onClick={() => {
              if (here) {
                if (ydoc) docRules.clearSkips(ydoc);
              } else for (const id of Object.keys(layer.never)) own.never(id, false);
            }}
          >
            Bring them back
          </button>
        )}
      </section>

      <section>
        <h4>As a file</h4>
        <p className="wf-proof-dim">{here ? "This document’s rules, to use in another document." : "Your rules, to carry to another device or hand to a co-writer."}</p>
        <div className="wf-proof-file">
          <button type="button" onClick={() => void save()}>
            Save to a file…
          </button>
          <button type="button" disabled={locked} onClick={() => fileRef.current?.click()}>
            Add from a file…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={`.${RULES_FILE_EXT},application/json`}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void load(file);
            }}
          />
        </div>
      </section>

      <details className="wf-proof-notice">
        <summary>About the table of spellings</summary>
        <p className="wf-proof-dim">Which English uses which spelling comes from VarCon, part of the SCOWL project, changed to suit this app. It is used under these terms.</p>
        <pre>{VARIANTS_NOTICE}</pre>
      </details>
    </div>
  );
}

function WordList({ list, layer, locked, onPut }: { list: (typeof LISTS)[number]; layer: Layer; locked: boolean; onPut: (entry: WordEntry | null, find?: string) => void }) {
  const [find, setFind] = useState("");
  const [use, setUse] = useState("");
  const [note, setNote] = useState("");
  const entries = Object.entries(layer.words).filter(([, e]) => e.k === list.kind);
  const ready = find.trim() !== "" && (list.kind !== "prefer" || (use.trim() !== "" && use.trim() !== find.trim()));
  const add = () => {
    if (!ready) return;
    onPut({ k: list.kind, find, ...(list.kind === "prefer" ? { use } : {}), ...(note.trim() ? { note } : {}) });
    setFind("");
    setUse("");
    setNote("");
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };
  return (
    <section>
      <h4>{list.title}</h4>
      <p className="wf-proof-dim">{list.hint}</p>
      {entries.length > 0 && (
        <ul className="wf-proof-words">
          {entries.map(([id, entry]) => (
            <li key={id}>
              <span>
                <b>{entry.find}</b>
                {entry.k === "prefer" && (
                  <>
                    {" to "}
                    <b>{entry.use}</b>
                  </>
                )}
                {entry.note && <i>{entry.note}</i>}
              </span>
              {!locked && (
                <button type="button" className="wf-icon" title={`Remove the rule for ${entry.find}`} aria-label={`Remove the rule for ${entry.find}`} onClick={() => onPut(null, entry.find)}>
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!locked && (
        <div className="wf-proof-add">
          <input value={find} placeholder={list.find} aria-label={list.find} maxLength={80} onChange={(e) => setFind(e.target.value)} onKeyDown={onKey} />
          {list.kind === "prefer" && <input value={use} placeholder="Write" aria-label="Write" maxLength={80} onChange={(e) => setUse(e.target.value)} onKeyDown={onKey} />}
          {list.kind !== "allow" && <input value={note} placeholder="A note, if you like" aria-label="A note" maxLength={300} onChange={(e) => setNote(e.target.value)} onKeyDown={onKey} />}
          <button type="button" disabled={!ready} onClick={add}>
            Add
          </button>
        </div>
      )}
    </section>
  );
}

/** Whether a word already has a rule (for "add to my rules"). */
export const hasWordRule = (layer: Layer, find: string): boolean => wordId(find) in layer.words;
