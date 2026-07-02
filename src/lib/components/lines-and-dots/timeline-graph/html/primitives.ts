import {
  DEFAULT_STROKE_COLOR,
  getCategoryStrokeColor,
  getStatusStrokeColor,
} from '$lib/components/lines-and-dots/constants';
import type { EventClassification, EventTypeCategory } from '$lib/types/events';
import type { WorkflowStatus } from '$lib/types/workflows';

// Pure helpers shared by the timeline's HTML rows. These are deliberately NOT
// components: the hot path (thousands of rows) renders lines/dots/text as
// inline markup + snippets so mounting a row creates plain DOM with no child
// component instances to construct, mount, or tear down on every scroll.

export type ColorPair = readonly [fill: string, stroke: string];

const DOT_DEFAULT: ColorPair = ['#e8efff', '#141414'];

const CLASSIFICATION_DOT_COLORS: Record<string, ColorPair> = {
  Started: ['#92a4c3', '#141414'],
  Completed: ['#1ff1a5', '#00964e'],
  Fired: ['#f8a208', '#fed64b'],
  Signaled: ['#d300d8', '#ff26ff'],
  Failed: ['#f55', '#c71607'],
  Terminated: ['#f55', '#c71607'],
  TimedOut: ['#c2570c', '#f97316'],
  Canceled: ['#fed64b', '#fff4c6'],
};

const CATEGORY_DOT_COLORS: Record<string, ColorPair> = {
  marker: ['#ebebeb', '#141414'],
  command: ['#ebebeb', '#141414'],
  timer: ['#fbbf24', '#141414'],
  signal: ['#d300d8', '#141414'],
  activity: ['#a78bfa', '#141414'],
  pending: ['#141414', '#a78bfa'],
  'child-workflow': ['#b2f8d9', '#141414'],
  update: ['#06b6d4', '#141414'],
  workflow: ['#059669', '#141414'],
};

export function dotColorPair(
  classification?: string | null,
  category?: string,
): ColorPair {
  return (
    (classification && CLASSIFICATION_DOT_COLORS[classification]) ||
    (category && CATEGORY_DOT_COLORS[category]) ||
    DOT_DEFAULT
  );
}

export function strokeColor({
  status,
  category,
  classification,
  delayed = false,
}: {
  status?: WorkflowStatus | 'none';
  category?: EventTypeCategory | 'pending' | 'retry';
  classification?: EventClassification;
  delayed?: boolean;
}): string {
  let color = DEFAULT_STROKE_COLOR;
  if (status) {
    color = status === 'none' ? '#141414' : getStatusStrokeColor(status);
  }
  if (category) {
    const categoryColor = getCategoryStrokeColor(category);
    if (categoryColor !== DEFAULT_STROKE_COLOR) color = categoryColor;
  }
  if (classification) {
    const statusColor = getStatusStrokeColor(classification);
    if (statusColor !== DEFAULT_STROKE_COLOR) color = statusColor;
  }
  if (delayed && (classification === 'Running' || status === 'Running')) {
    color = getStatusStrokeColor('Delayed');
  }
  if (category === 'pending' || category === 'retry') {
    color = getCategoryStrokeColor(category);
  }
  return color;
}

const CATEGORY_TEXT_COLOR: Record<string, string> = {
  marker: '#ebebeb',
  command: '#ebebeb',
  timer: '#fbbf24',
  signal: '#ec4899',
  activity: '#a78bfa',
  pending: '#a78bfa',
  'child-workflow': '#0891b2',
  workflow: '#059669',
  Failed: '#ff4418',
};

export function textColor({
  backdrop = false,
  label = false,
  category,
}: {
  backdrop?: boolean;
  label?: boolean;
  category?: string;
}): string {
  if (backdrop) return '#ffffff';
  if (label) return '#c9d9f0';
  return (category && CATEGORY_TEXT_COLOR[category]) || 'currentColor';
}

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
