<script lang="ts">
  import type { Timestamp } from '$lib/types';
  import { formatDistanceAbbreviated } from '$lib/utilities/format-time';

  import { TimelineConfig } from '../constants';
  import Line from '../svg/line.svelte';

  import type { TimelineScale } from './timeline-scale.svelte';

  type Props = {
    x1: number;
    x2: number;
    gutter: number;
    timelineHeight: number;
    startTime: string | Timestamp;
    scale: TimelineScale;
  };
  let {
    x1 = 0,
    x2 = 1000,
    gutter = 0,
    timelineHeight = 1000,
    startTime,
    scale,
  }: Props = $props();

  const { radius } = TimelineConfig;

  // Aim for roughly one tick per TARGET_TICK_PX of axis width, clamped so a
  // very narrow or very wide timeline still gets a sensible number of ticks.
  const TARGET_TICK_PX = 60;
  const MIN_TICKS = 2;
  const MAX_TICKS = 40;

  const distance = $derived(x2 - x1);
  const tickCount = $derived(
    Math.min(
      MAX_TICKS,
      Math.max(MIN_TICKS, Math.round(distance / TARGET_TICK_PX)),
    ),
  );
  const tickDistance = $derived(distance / tickCount);

  const startMs = $derived(scale.unproject(x1 - gutter));
  const endMs = $derived(scale.unproject(x2 - gutter));
  const includeMilliseconds = $derived((endMs - startMs) / tickCount < 1000);

  // Collapsed segments compress a large time span into a fixed sliver, so ticks
  // that land inside one would show a misleading label and collide with the
  // collapse marker/zigzag drawn there. Track their pixel ranges (in axis space,
  // hence the +gutter) to skip both grid and labels within them.
  const collapsedRanges = $derived(
    scale.segments
      .filter((segment) => segment.isCollapsed)
      .map((segment) => ({
        startX: gutter + segment.startPx,
        endX: gutter + segment.endPx,
      })),
  );

  const isInsideCollapsed = (x: number): boolean =>
    collapsedRanges.some((range) => x >= range.startX && x <= range.endX);

  // The grid spans [x1, x2] minus the collapsed ranges. Each gap is filled with
  // the same globally-anchored pattern so dashes stay on the tick positions
  // regardless of where the gap starts.
  const gridRects = $derived.by(() => {
    const ranges = [...collapsedRanges].sort((a, b) => a.startX - b.startX);
    const rects: { x: number; width: number }[] = [];
    let cursor = x1;
    for (const range of ranges) {
      const end = Math.min(range.startX, x2);
      if (end > cursor) {
        rects.push({ x: cursor, width: end - cursor });
      }
      cursor = Math.max(cursor, range.endX);
      if (cursor >= x2) break;
    }
    if (cursor < x2) {
      rects.push({ x: cursor, width: x2 - cursor });
    }
    return rects;
  });
</script>

<!--
  Vertical tick grid. Each expanded span is a single <rect> filled with a
  repeating <pattern> so the browser rasterizes one tiny dash tile and tiles it
  (clipped to the painted area) rather than tessellating a dash pattern along a
  full-height stroke — the latter is O(timelineHeight) per line and regresses
  badly on tall histories. The pattern is anchored at x1 + tickDistance so the
  dashes land on the same tick positions as the labels below.
-->
<defs>
  <pattern
    id="timeline-tick-grid"
    patternUnits="userSpaceOnUse"
    x={x1 + tickDistance}
    y={0}
    width={tickDistance}
    height={4}
  >
    <rect class="grid-dot" x={0} y={0} width={1} height={2} />
  </pattern>
</defs>
{#each gridRects as rect (rect.x)}
  <rect
    fill="url(#timeline-tick-grid)"
    x={rect.x}
    y={0}
    width={rect.width}
    height={timelineHeight}
  />
{/each}
<Line
  strokeWidth={radius / 2}
  startPoint={[x1, timelineHeight]}
  endPoint={[x1 + distance, timelineHeight]}
/>
{#each Array(tickCount) as _, i (i)}
  {@const tickX = x1 + i * tickDistance}
  {@const tickY = timelineHeight + radius * 2}
  {#if i !== 0 && !isInsideCollapsed(tickX)}
    <text
      fill="#fff"
      font-size="12"
      transform="rotate(45, {tickX}, {tickY})"
      x={tickX - radius}
      y={tickY + 3}
    >
      {formatDistanceAbbreviated({
        start: startTime,
        end: new Date(scale.unproject(tickX - gutter)),
        includeMilliseconds,
      })}
    </text>
  {/if}
{/each}

<style lang="postcss">
  text {
    @apply fill-current;
  }

  .grid-dot {
    fill: currentColor;
    opacity: 0.3;
  }
</style>
