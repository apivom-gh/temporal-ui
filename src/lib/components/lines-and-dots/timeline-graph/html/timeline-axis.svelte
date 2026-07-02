<script lang="ts">
  import type { Timestamp } from '$lib/types';
  import { formatDistanceAbbreviated } from '$lib/utilities/format-time';

  import { TimelineConfig } from '../../constants';
  import type { TimelineScale } from '../timeline-scale.svelte';

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

  // Collapsed segments compress a large span into a fixed sliver, so a tick
  // inside one would show a misleading label and collide with the collapse
  // marker/zigzag. Skip grid + labels within them.
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

  // Tick x positions (skip i=0, that's the rail). Each becomes a dotted vertical
  // grid line + a rotated label unless it falls inside a collapsed range.
  const ticks = $derived(
    Array.from({ length: tickCount }, (_, i) => x1 + i * tickDistance).filter(
      (x, i) => i !== 0 && !isInsideCollapsed(x),
    ),
  );

  const baselineWidth = radius / 2;
</script>

<!-- baseline -->
<div
  class="baseline"
  style="left:{x1}px;top:{timelineHeight -
    baselineWidth / 2}px;width:{distance}px;height:{baselineWidth}px;"
></div>

{#each ticks as tickX (tickX)}
  <div
    class="grid-line"
    style="left:{tickX}px;top:0;height:{timelineHeight}px;"
  ></div>
  <div
    class="tick-label"
    style="left:{tickX}px;top:{timelineHeight + radius}px;"
  >
    {formatDistanceAbbreviated({
      start: startTime,
      end: new Date(scale.unproject(tickX - gutter)),
      includeMilliseconds,
    })}
  </div>
{/each}

<style lang="postcss">
  .baseline {
    position: absolute;
    background: currentColor;
  }

  .grid-line {
    position: absolute;
    width: 1px;
    opacity: 0.3;
    background-image: repeating-linear-gradient(
      to bottom,
      currentColor 0 2px,
      transparent 2px 4px
    );
  }

  .tick-label {
    position: absolute;
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
    transform: rotate(45deg);
    transform-origin: left center;
    pointer-events: none;
  }
</style>
