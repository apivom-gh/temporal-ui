// Pure helpers shared by the timeline's HTML rows. These are deliberately NOT
// components: the hot path (thousands of rows) renders lines/dots/text as
// inline markup + snippets so mounting a row creates plain DOM with no child
// component instances to construct, mount, or tear down on every scroll.
//
// Color/stroke helpers (dotColors, strokeColor) live in ../constants so the SVG
// history graph can share them.

// Top-left corner of a dot's bounding box, centered on (cx, cy). The dot's
// width/height/border-radius are constant (driven by CSS vars set on .canvas),
// so only this position is computed per event.
export function dotBox(
  cx: number,
  cy: number,
  radius: number,
  stroke = 2,
): { left: number; top: number } {
  const offset = radius + stroke / 2;
  return { left: cx - offset, top: cy - offset };
}

export type Box = { left: number; top: number; width: number; height: number };

// Map an SVG stroke (centered on the path) to a div box. Lines are axis-aligned:
// the long axis spans the two points; the short axis is strokeWidth centered on
// the shared coordinate. Negative x clamps to 0 (matches the SVG Math.max(0,…)).
export function lineBox(
  startPoint: [number, number],
  endPoint: [number, number],
  strokeWidth: number,
): Box {
  const x1 = Math.max(0, startPoint[0]);
  const y1 = startPoint[1];
  const x2 = Math.max(0, endPoint[0]);
  const y2 = endPoint[1];
  const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
  return {
    left: horizontal ? Math.min(x1, x2) : x1 - strokeWidth / 2,
    top: horizontal ? y1 - strokeWidth / 2 : Math.min(y1, y2),
    width: horizontal ? Math.abs(x2 - x1) : strokeWidth,
    height: horizontal ? strokeWidth : Math.abs(y2 - y1),
  };
}
