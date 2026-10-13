import type { Editor } from "@tiptap/react";
import { Accessibility, Frame, Ruler, SquareRoundCorner } from "lucide-react";
import { useEffect, useState } from "react";

import { selectedImage, setImageAttrs } from "../nodes/Image";
import { imageBorder, imageRound } from "../schema/sanitize";
import { ColorFlyout, TEXT_COLORS } from "./ColorFlyout";
import { Flyout, FlyoutItem } from "./Flyout";

const WEIGHTS = [0.5, 1, 1.5, 2.25, 3, 4.5, 6];
const CORNERS: { label: string; round: number | null }[] = [
  { label: "Square", round: null },
  { label: "Slightly rounded", round: 6 },
  { label: "Rounded", round: 16.7 },
  { label: "Very rounded", round: 30 },
  { label: "Circle or oval", round: 50 },
];
/** A black to begin with, ahead of the colours text is given. */
const LINE_COLORS = [{ color: "#000000", name: "Black" }, ...TEXT_COLORS];

/** The line round the selected picture: its colour (none: no line) and how
 *  thick it is. */
export function PictureBorder({ editor }: { editor: Editor }) {
  const border = imageBorder(selectedImage(editor)?.node.attrs.bdr);
  return (
    <>
      <ColorFlyout
        title="A line round the picture"
        icon={<Frame size={15} />}
        label="Border"
        value={border?.color ?? null}
        colors={LINE_COLORS}
        noneLabel="No border"
        onPick={(color) => setImageAttrs(editor, { border: color ? { w: border?.w ?? 1.5, color } : null })}
      />
      <select
        className="wf-ribbon-select narrow"
        title="How thick the border is"
        aria-label="How thick the border is"
        disabled={!border}
        value={border ? String(border.w) : ""}
        onChange={(e) => border && setImageAttrs(editor, { border: { ...border, w: Number(e.target.value) } })}
      >
        {!border && <option value="">Thickness</option>}
        {(border && !WEIGHTS.includes(border.w) ? [...WEIGHTS, border.w].sort((a, b) => a - b) : WEIGHTS).map((w) => (
          <option key={w} value={String(w)}>
            {w} pt
          </option>
        ))}
      </select>
    </>
  );
}

/** How round the selected picture's corners are. */
export function PictureCorners({ editor }: { editor: Editor }) {
  const round = imageRound(selectedImage(editor)?.node.attrs.round);
  // (What a file from elsewhere gave it may be none of these: the nearest is ticked.)
  const nearest = round === null ? null : CORNERS.filter((c) => c.round !== null).reduce((a, b) => (Math.abs((b.round ?? 0) - round) < Math.abs((a.round ?? 0) - round) ? b : a)).round;
  return (
    <Flyout title="The picture's corners" icon={<SquareRoundCorner size={15} />} label="Corners" active={round !== null}>
      {(close) => (
        <>
          {CORNERS.map((c) => (
            <FlyoutItem
              key={c.label}
              checked={c.round === nearest}
              onPick={() => {
                setImageAttrs(editor, { round: c.round });
                close();
              }}
            >
              {c.label}
            </FlyoutItem>
          ))}
        </>
      )}
    </Flyout>
  );
}

const PX_PER_IN = 96;
const inches = (px: number) => String(Math.round((px / PX_PER_IN) * 100) / 100);

/** The selected picture's size, in inches: one side follows the other. */
export function PictureSize({ editor }: { editor: Editor }) {
  const node = selectedImage(editor)?.node;
  const w = Number(node?.attrs.width) || 0;
  const h = Number(node?.attrs.height) || 0;
  return (
    <Flyout title="The picture's size" icon={<Ruler size={15} />} label="Size" panelClass="wf-link-flyout">
      {(close) => <SizeForm editor={editor} w={w} h={h} close={close} />}
    </Flyout>
  );
}

function SizeForm({ editor, w, h, close }: { editor: Editor; w: number; h: number; close: () => void }) {
  const [wide, setWide] = useState(w ? inches(w) : "");
  const [tall, setTall] = useState(h ? inches(h) : "");
  useEffect(() => {
    setWide(w ? inches(w) : "");
    setTall(h ? inches(h) : "");
  }, [w, h]);
  const shape = w > 0 && h > 0 ? h / w : 0;
  const px = (text: string) => {
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? Math.round(n * PX_PER_IN) : 0;
  };
  return (
    <form
      className="wf-link-form"
      onSubmit={(e) => {
        e.preventDefault();
        const width = px(wide);
        const height = px(tall);
        if (width && height) setImageAttrs(editor, { width, height });
        close();
      }}
    >
      <label>
        <span>Width, inches</span>
        <input
          type="number"
          step="0.05"
          min="0.1"
          value={wide}
          autoFocus
          onChange={(e) => {
            setWide(e.target.value);
            if (shape && px(e.target.value)) setTall(inches(px(e.target.value) * shape));
          }}
        />
      </label>
      <label>
        <span>Height, inches</span>
        <input
          type="number"
          step="0.05"
          min="0.1"
          value={tall}
          onChange={(e) => {
            setTall(e.target.value);
            if (shape && px(e.target.value)) setWide(inches(px(e.target.value) / shape));
          }}
        />
      </label>
      <div className="wf-link-actions">
        <button type="submit" className="wf-primary" disabled={!px(wide) || !px(tall)}>
          Set
        </button>
      </div>
    </form>
  );
}

/** What the selected picture shows, in words: for someone who can't see it
 *  (a screen reader says it, and it goes with the picture into Word). */
export function PictureAlt({ editor }: { editor: Editor }) {
  const alt = String(selectedImage(editor)?.node.attrs.alt ?? "");
  return (
    <Flyout title="What the picture shows, for someone who can’t see it" icon={<Accessibility size={15} />} label="Description" active={!!alt} panelClass="wf-link-flyout">
      {(close) => <AltForm editor={editor} initial={alt} close={close} />}
    </Flyout>
  );
}

function AltForm({ editor, initial, close }: { editor: Editor; initial: string; close: () => void }) {
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  return (
    <form
      className="wf-link-form"
      onSubmit={(e) => {
        e.preventDefault();
        setImageAttrs(editor, { alt: text });
        close();
      }}
    >
      <label>
        <span>Description</span>
        <input value={text} maxLength={500} autoFocus placeholder="What the picture shows" onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="wf-link-actions">
        <button type="submit" className="wf-primary">
          Save
        </button>
      </div>
    </form>
  );
}
