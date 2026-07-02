<script lang="ts">
  import Icon from '$lib/holocene/icon/icon.svelte';
  import { translate } from '$lib/i18n/translate';
  import { formatDistanceAbbreviated } from '$lib/utilities/format-time';

  import { RADIUS, ROW_HEIGHT } from './constants';

  import type { TimelineScale } from './timeline-scale.svelte';

  type Props = {
    scale: TimelineScale;
    timelineHeight: number;
    readOnly?: boolean;
    onToggle: (segmentKey: string) => void;
  };
  let { scale, timelineHeight, readOnly = false, onToggle }: Props = $props();

  const ZIGZAG_HALF_WIDTH = 5;
  const ZIGZAG_STEP = 8;

  const HIT_HALF_WIDTH = Math.max(RADIUS, 12);
  const HIT_WIDTH = HIT_HALF_WIDTH * 2;
  const iconSize = RADIUS * 2;

  const collapsibleSegments = $derived(
    scale.segments.filter((s) => s.isCollapsible),
  );

  const handleToggle = (segmentKey: string) => {
    if (readOnly) return;
    onToggle(segmentKey);
  };
</script>

{#snippet marker(centerX: number, centerY: number)}
  <div
    class="absolute bg-primary"
    style:left="{centerX - HIT_HALF_WIDTH}px"
    style:top="{centerY - RADIUS}px"
    style:width="{HIT_WIDTH}px"
    style:height="{RADIUS * 2}px"
  ></div>
  <div
    class="absolute"
    style:left="{centerX - iconSize / 2}px"
    style:top="{centerY - iconSize / 2}px"
    style:width="{iconSize}px"
    style:height="{iconSize}px"
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
  {@const labelY = timelineHeight + RADIUS * 2}
  {@const distance = formatDistanceAbbreviated({
    start: new Date(seg.startTimeMs),
    end: new Date(seg.endTimeMs),
  })}
  {#if seg.isCollapsed}
    {@const half = Math.min(ZIGZAG_HALF_WIDTH, (seg.endPx - seg.startPx) / 4)}
    <!-- Full-height zigzag as a tiled <pattern> (rasterized once, not a long polyline). -->
    <svg
      class="absolute top-0 overflow-visible"
      style:left="{labelX - half}px"
      style:width="{half * 2}px"
      style:height="{timelineHeight}px"
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
    {@render marker(labelX, ROW_HEIGHT)}
    {@render marker(labelX, timelineHeight)}
    <div
      class="pointer-events-none absolute origin-left rotate-45 whitespace-nowrap text-[10px] leading-none text-secondary"
      style:left="{labelX}px"
      style:top="{labelY}px"
    >
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
      class="absolute top-0 m-0 cursor-pointer border-0 bg-current p-0 opacity-0 outline-none transition-opacity duration-100 ease-in-out hover:opacity-20 focus-visible:opacity-20"
      style:left="{seg.isCollapsed ? labelX - HIT_HALF_WIDTH : seg.startPx}px"
      style:width="{seg.isCollapsed ? HIT_WIDTH : seg.endPx - seg.startPx}px"
      style:height="{timelineHeight}px"
      onclick={() => handleToggle(seg.key)}
    ></button>
  {/if}
{/each}

<style lang="postcss">
  .zigzag-path {
    stroke: rgb(var(--color-text-secondary));
  }
</style>
