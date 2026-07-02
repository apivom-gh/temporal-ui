<script lang="ts">
  import Icon from '$lib/holocene/icon/icon.svelte';
  import { translate } from '$lib/i18n/translate';
  import { formatDistanceAbbreviated } from '$lib/utilities/format-time';

  import { TimelineConfig } from '../constants';

  import type { TimelineScale } from './timeline-scale.svelte';

  type Props = {
    scale: TimelineScale;
    timelineHeight: number;
    readOnly?: boolean;
    onToggle: (segmentKey: string) => void;
  };
  let { scale, timelineHeight, readOnly = false, onToggle }: Props = $props();

  const { radius, height } = TimelineConfig;

  const ZIGZAG_HALF_WIDTH = 5;
  const ZIGZAG_STEP = 8;

  const HIT_HALF_WIDTH = Math.max(radius, 12);
  const HIT_WIDTH = HIT_HALF_WIDTH * 2;
  const iconSize = radius * 2;

  const collapsibleSegments = $derived(
    scale.segments.filter((s) => s.isCollapsible),
  );

  const handleToggle = (segmentKey: string) => {
    if (readOnly) return;
    onToggle(segmentKey);
  };
</script>

{#snippet marker(cx: number, cy: number)}
  <div
    class="marker"
    style="left:{cx - HIT_HALF_WIDTH}px;top:{cy -
      radius}px;width:{HIT_WIDTH}px;height:{radius * 2}px;"
  ></div>
  <div
    class="marker-icon"
    style="left:{cx - iconSize / 2}px;top:{cy -
      iconSize / 2}px;width:{iconSize}px;height:{iconSize}px;"
  >
    <Icon
      class="text-secondary"
      name="timeline-collapse"
      width={iconSize}
      height={iconSize}
    />
  </div>
{/snippet}

{#each collapsibleSegments as seg (seg.key)}
  {@const labelX = (seg.startPx + seg.endPx) / 2}
  {@const labelY = timelineHeight + radius * 2}
  {@const distance = formatDistanceAbbreviated({
    start: new Date(seg.startTimeMs),
    end: new Date(seg.endTimeMs),
  })}
  {#if seg.isCollapsed}
    {@const half = Math.min(ZIGZAG_HALF_WIDTH, (seg.endPx - seg.startPx) / 4)}
    <!-- Full-height zigzag: one tiled <pattern> of a single period, rasterized
         once by the browser rather than an O(timelineHeight) polyline. -->
    <svg
      class="zigzag"
      style="left:{labelX - half}px;top:0;width:{half *
        2}px;height:{timelineHeight}px;"
    >
      <defs>
        <pattern
          id="zigzag-{seg.key}"
          patternUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={half * 2}
          height={ZIGZAG_STEP * 2}
        >
          <path
            class="zigzag-path"
            d="M 0 0 L {half * 2} {ZIGZAG_STEP} L 0 {ZIGZAG_STEP * 2}"
            fill="none"
            stroke-width="1"
            stroke-dasharray="2"
          />
        </pattern>
      </defs>
      <rect
        width={half * 2}
        height={timelineHeight}
        fill="url(#zigzag-{seg.key})"
      />
    </svg>
    {@render marker(labelX, height)}
    {@render marker(labelX, timelineHeight)}
    <div class="zigzag-label" style="left:{labelX}px;top:{labelY}px;">
      {distance}
    </div>
  {/if}
  {#if !readOnly}
    <button
      type="button"
      aria-pressed={seg.isCollapsed}
      aria-label={seg.isCollapsed
        ? translate('workflows.show-idle-time-segment', { distance })
        : translate('workflows.hide-idle-time-segment', { distance })}
      class="toggle-handle"
      style="left:{seg.isCollapsed
        ? labelX - HIT_HALF_WIDTH
        : seg.startPx}px;top:0;width:{seg.isCollapsed
        ? HIT_WIDTH
        : seg.endPx - seg.startPx}px;height:{timelineHeight}px;"
      onclick={() => handleToggle(seg.key)}
    ></button>
  {/if}
{/each}

<style lang="postcss">
  .zigzag {
    position: absolute;
    overflow: visible;
  }

  .zigzag-path {
    stroke: rgb(var(--color-text-secondary));
  }

  .zigzag-label {
    position: absolute;
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    transform: rotate(45deg);
    transform-origin: left center;
    fill: rgb(var(--color-text-secondary));
    color: rgb(var(--color-text-secondary));
    pointer-events: none;
  }

  .marker {
    position: absolute;
    background: rgb(var(--color-surface-primary));
  }

  .marker-icon {
    position: absolute;
  }

  .toggle-handle {
    position: absolute;
    margin: 0;
    padding: 0;
    border: 0;
    background: currentColor;
    cursor: pointer;
    opacity: 0;
    outline: none;
    transition: opacity 0.1s ease-in-out;
  }

  .toggle-handle:hover,
  .toggle-handle:focus-visible {
    opacity: 0.2;
  }
</style>
