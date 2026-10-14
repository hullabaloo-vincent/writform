import { Flyout, FlyoutItem, useIsPhone } from "../../../editor/ui/Flyout";
import { useDocZoom, ZOOM_STEPS, zoomLabel } from "./zoom";

/** The page's size while writing: the figure it is at, and a menu of the
 *  others. (Ctrl or ⌘ with the wheel and a pinch change it too.) Phones
 *  have none: there the page already fits the screen. */
export function ZoomControl() {
  const phone = useIsPhone();
  const mode = useDocZoom((s) => s.mode);
  const z = useDocZoom((s) => s.z);
  const shown = useDocZoom((s) => s.shown);
  const set = useDocZoom((s) => s.set);
  const fit = useDocZoom((s) => s.fit);
  if (phone) return null;
  return (
    <Flyout title="Zoom" label={zoomLabel(shown)} className="wf-zoom-btn">
      {(close) => (
        <>
          {ZOOM_STEPS.map((step) => (
            <FlyoutItem
              key={step}
              checked={mode === "percent" && Math.abs(z - step) < 0.005}
              onPick={() => {
                set(step);
                close();
              }}
            >
              {zoomLabel(step)}
            </FlyoutItem>
          ))}
          <div className="wf-flyout-heading">Fit to the window</div>
          <FlyoutItem
            checked={mode === "width"}
            onPick={() => {
              fit("width");
              close();
            }}
          >
            Page width
          </FlyoutItem>
          <FlyoutItem
            checked={mode === "page"}
            onPick={() => {
              fit("page");
              close();
            }}
          >
            Whole page
          </FlyoutItem>
        </>
      )}
    </Flyout>
  );
}
