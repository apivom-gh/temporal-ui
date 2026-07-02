<script lang="ts">
  import { twMerge } from 'tailwind-merge';

  import { timestamp } from '$lib/components/timestamp.svelte';
  import type { EventGroups } from '$lib/models/event-groups/event-groups';
  import { activeGroups } from '$lib/stores/active-events';
  import { fullEventHistory } from '$lib/stores/events';
  import { eventStatusFilter } from '$lib/stores/filters';
  import type { WorkflowExecution } from '$lib/types/workflows';
  import { isWorkflowDelayed } from '$lib/utilities/delayed-workflows';
  import { type ValidTime, validTimeToDate } from '$lib/utilities/format-time';
  import { getFailedOrPendingGroups } from '$lib/utilities/get-failed-or-pending';

  import { TimelineConfig } from '../constants';
  import EndTimeInterval from '../end-time-interval.svelte';
  import TimelineIconDefs from '../svg/timeline-icon-defs.svelte';
  import {
    getDescStart,
    getPendingBlockY,
    getRowY,
    getTotalForY,
  } from '../svg/timeline-positioning';

  import GroupDetailsRow from './html/group-details-row.svelte';
  import TimelineAxis from './html/timeline-axis.svelte';
  import TimelineCollapsedLayer from './html/timeline-collapsed-layer.svelte';
  import TimelineGraphRow from './html/timeline-graph-row.svelte';
  import WorkflowRow from './html/workflow-row.svelte';
  import { TimelineScale } from './timeline-scale.svelte';
  import { Timeline } from './timeline.svelte';
  import { Viewport } from './viewport.svelte';

  interface Props {
    workflow: WorkflowExecution;
    groups: EventGroups;
    readOnly?: boolean;
    error?: boolean;
    reverseSort?: boolean;
    loading?: boolean;
    totalExpectedEvents?: number;
    descMinId?: number;
    panelHeight?: number;
    onTimelineInit?: (timeline: Timeline) => void;
  }

  let {
    workflow,
    groups,
    readOnly = false,
    error = false,
    reverseSort = false,
    loading = false,
    totalExpectedEvents = 0,
    descMinId = 0,
    panelHeight = $bindable(0),
    onTimelineInit,
  }: Props = $props();

  const { height, gutter, radius } = TimelineConfig;
  const DOT_STROKE = 2; // dot border (matches the SVG Dot default)
  // Constant dot geometry, published as CSS vars on .canvas so every row's dot
  // reads them via var() instead of recomputing size/radius inline per event.
  const dotSize = 2 * radius + DOT_STROKE;
  const dotRadius = radius * 0.3 + DOT_STROKE / 2;

  let canvasWidth = $state(0);

  // PERF: bind:clientWidth={canvasWidth} compiled to bind_element_size which reads
  // element.clientWidth inside a Svelte effect during every reactive flush (~150×
  // in T4). Each read forces a full synchronous layout of the 40k-row SVG (~3ms
  // each = 4.2% total CPU). Two fixes combined:
  //   1. Use contentRect.width from the ResizeObserver callback — the browser
  //      already computed this, no additional reflow needed.
  //   2. Debounce via requestAnimationFrame to break any oscillation where a width
  //      change causes re-renders that change the width again.
  let containerEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!containerEl) return;
    // PERF: Use contentRect.width from the ResizeObserver callback — the browser
    // already computed it during layout, so reading it here forces no extra
    // reflow (unlike offsetWidth/clientWidth). First callback applies
    // immediately (no flash); later ones are RAF-debounced to break any
    // width→re-render→width oscillation.
    let isFirst = true;
    let rafId: ReturnType<typeof requestAnimationFrame>;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (isFirst) {
        isFirst = false;
        canvasWidth = w;
      } else {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          canvasWidth = w;
        });
      }
    });
    observer.observe(containerEl);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  });

  const timelineWidth = $derived(canvasWidth - 2 * gutter);

  let nowMs = $state(Date.now());

  const timeline = new Timeline({
    getFullEventHistory: () => $fullEventHistory,
    getWorkflow: () => workflow,
    getEventGroups: () => groups,
    getCurrentTimeMs: () => nowMs,
  });

  const viewport = new Viewport({ startTimeMs: 0, endTimeMs: 0 });
  const scale = new TimelineScale({ timeline, viewport });

  $effect(() => {
    onTimelineInit?.(timeline);
  });

  $effect(() => {
    viewport.setSize(timelineWidth, 0);
  });

  const projectX = (time: ValidTime | undefined | null): number => {
    if (!time) return gutter;
    return scale.project(validTimeToDate(time).getTime()) + gutter;
  };

  const toggleSegment = (segmentKey: string) => {
    const segment = timeline.segments.find(
      (s) => s.timespan.key === segmentKey,
    );
    if (segment) {
      timeline.toggleTimeSegment(segment);
    }
  };

  const filteredGroups = $derived(
    getFailedOrPendingGroups(groups, $eventStatusFilter),
  );

  // Skeleton rows: how many unfetched groups remain.
  // totalExpectedEvents is already a density-adjusted group count (computed in
  // workflow-timeline-layout) so subtracting filteredGroups.length is correct.
  const pendingGroupCount = $derived.by(() => {
    if (!loading) return 0;
    if (!totalExpectedEvents) {
      return filteredGroups.length === 0 ? 50 : 0;
    }
    return Math.max(0, totalExpectedEvents - filteredGroups.length);
  });

  // Scroll-window virtualization: only rows within OVERSCAN rows of the current
  // viewport are mounted. getWindowBounds maps the visible band → row indices.
  //
  // OVERSCAN = 12 rows × 24 px = 288 px buffer per side, so edge rows stay
  // mounted through small scrolls and direction reversals instead of thrashing
  // mount/unmount, and rows are ready ahead of a fast fling.
  const OVERSCAN = 12;

  // O(1) closed-form inverse of getRowY for each of the two cursor segments.
  // Both segments are linear (y = m*i + b), so inverting is pure arithmetic.
  // Returns [start, end) indices into filteredGroups.
  function getWindowBounds(
    sy: number,
    vp: number,
    total: number,
    h: number,
    os: number,
    rs: boolean,
    ds: number,
    pc: number,
    tfy: number,
  ): [number, number] {
    if (total === 0 || !vp) {
      const cap = Math.min(total, 100);
      return rs ? [Math.max(0, total - cap), total] : [0, cap];
    }
    const yMin = sy - os * h;
    const yMax = sy + vp + os * h;
    let s = total;
    let e = 0;
    if (!rs) {
      // Segment 1 [0, ds): y = (i+2)*h
      const s1s = Math.max(0, Math.ceil(yMin / h - 2));
      const s1e = Math.min(ds, Math.floor(yMax / h - 2) + 1);
      if (s1s < s1e) {
        s = Math.min(s, s1s);
        e = Math.max(e, s1e);
      }
      // Segment 2 [ds, N): y = (i+2+pc)*h
      const s2s = Math.max(ds, Math.ceil(yMin / h - 2 - pc));
      const s2e = Math.min(total, Math.floor(yMax / h - 2 - pc) + 1);
      if (s2s < s2e) {
        s = Math.min(s, s2s);
        e = Math.max(e, s2e);
      }
    } else {
      // Segment 1 [0, ds): y = (tfy+1-i)*h  → i = tfy+1 - y/h
      const s1s = Math.max(0, Math.ceil(tfy + 1 - yMax / h));
      const s1e = Math.min(ds, Math.floor(tfy + 1 - yMin / h) + 1);
      if (s1s < s1e) {
        s = Math.min(s, s1s);
        e = Math.max(e, s1e);
      }
      // Segment 2 [ds, N): y = (tfy+1-i-pc)*h → i = tfy+1-pc - y/h
      const s2s = Math.max(ds, Math.ceil(tfy + 1 - pc - yMax / h));
      const s2e = Math.min(total, Math.floor(tfy + 1 - pc - yMin / h) + 1);
      if (s2s < s2e) {
        s = Math.min(s, s2s);
        e = Math.max(e, s2e);
      }
    }
    return s >= e ? [0, 0] : [s, e];
  }

  const firstStartTime = $derived.by(() => {
    const firstEventTime = $fullEventHistory[0]?.eventTime;

    if (!firstEventTime) {
      return workflow.executionTime;
    }

    return firstEventTime < workflow.executionTime
      ? firstEventTime
      : workflow.executionTime;
  });

  const startTime = $derived(
    (!isWorkflowDelayed(workflow) && firstStartTime) || workflow.startTime,
  );

  const groupIndexMap = $derived(
    new Map(filteredGroups.map((g, i) => [g.id, i])),
  );

  // PERF: Index of the currently active group in filteredGroups (-1 = none).
  // Derived here so only the two rendering sections below subscribe to
  // $activeGroups, not the main row {#each}.
  const activeIdx = $derived(
    $activeGroups.length > 0 ? (groupIndexMap.get($activeGroups[0]) ?? -1) : -1,
  );

  $effect(() => {
    if ($activeGroups.length === 0) panelHeight = 0;
  });

  // PERF SORT: reverseSort flips which side of activeIdx the panel shift applies
  // to. Ascending: rows AFTER the active one (i > idx) move down. Descending:
  // rows BEFORE it (i < idx) are visually below the panel and move down instead.
  // Pooled rows are few and stable, so computing this per slot in the template
  // is cheap — no imperative element map needed.
  function shiftFor(i: number): string {
    if (activeIdx < 0 || panelHeight === 0) return '';
    const shifted = reverseSort ? i < activeIdx : i > activeIdx;
    return shifted ? `transform:translateY(${panelHeight}px);` : '';
  }

  const descStart = $derived(
    getDescStart(filteredGroups, descMinId, loading, pendingGroupCount),
  );

  const totalForY = $derived(
    getTotalForY(filteredGroups.length, pendingGroupCount, descStart),
  );

  // The open detail panel shifts every row below it down by panelHeight (via a
  // transform), but getWindowBounds maps y → rows using the unshifted getRowY.
  // Widen the mount window by the panel's row span so those shifted rows stay
  // mounted instead of leaving a blank band under the panel.
  const windowOverscan = $derived(OVERSCAN + Math.ceil(panelHeight / height));

  // Full drawn height of the timeline (rows + axis + detail panel). The SVG is
  // this tall plus a label zone and scrolls with the page — there is no
  // translateY; the page itself pans it.
  const timelineHeight = $derived(
    Math.max(height * (filteredGroups.length + pendingGroupCount + 2), 120) +
      panelHeight,
  );
  const AXIS_LABEL_ZONE = 150;
  const svgHeight = $derived(timelineHeight + AXIS_LABEL_ZONE);

  // ── Scroll-driven virtualization ────────────────────────────────────────────
  // The timeline scrolls inside an overflow ancestor (#content-wrapper). We read
  // the container's offset within that scroller on each scroll frame to get the
  // visible pixel band, then feed it to getWindowBounds (asc/desc/pending aware)
  // so only rows in view (+ overscan) mount.
  //
  // This deliberately does NOT use IntersectionObserver: the browser batches IO
  // callbacks during fast scroll (in one trace: 36 callbacks for 408 scroll
  // updates), so the mounted window trailed the viewport and rows only appeared
  // once scrolling slowed. A per-frame getBoundingClientRect read stays locked
  // to the viewport instead.
  let visibleBand = $state<[number, number] | null>(null);
  let scroller: HTMLElement | null = null;
  let bandRafId: ReturnType<typeof requestAnimationFrame> | undefined;
  let lastTop = NaN;
  let lastHeight = NaN;
  let stableFrames = 0;
  // ~8 frames (~130ms) of no movement before the sampling loop stops.
  const STABLE_FRAMES = 8;

  // Sample the viewport offset every frame while scrolling, rather than once per
  // scroll event. A wheel/trackpad fling fires `wheel` events but coalesces (or
  // drops) `scroll` events for the duration — so a scroll-event-driven measure
  // goes stale mid-fling and rows blank out until it settles. A self-driven rAF
  // loop reads the real position each frame regardless of which events fire.
  function sampleBand() {
    bandRafId = undefined;
    if (!containerEl) return;
    const elTop = containerEl.getBoundingClientRect().top;
    const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const viewHeight = scroller ? scroller.clientHeight : window.innerHeight;
    // Container-local coordinate aligned with the top of the visible area.
    const top = viewTop - elTop;

    if (top !== lastTop || viewHeight !== lastHeight) {
      lastTop = top;
      lastHeight = viewHeight;
      stableFrames = 0;
      visibleBand = [top, top + viewHeight];
    } else {
      stableFrames++;
    }

    // Keep sampling until the position has held still for STABLE_FRAMES, then
    // idle out. Any scroll/wheel/touch event pokes it back to life.
    if (stableFrames < STABLE_FRAMES) {
      bandRafId = requestAnimationFrame(sampleBand);
    }
  }

  function pokeSampler() {
    stableFrames = 0;
    if (bandRafId === undefined) {
      bandRafId = requestAnimationFrame(sampleBand);
    }
  }

  function findScrollParent(node: HTMLElement): HTMLElement | null {
    let el = node.parentElement;
    while (el) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') return el;
      el = el.parentElement;
    }
    return null;
  }

  $effect(() => {
    if (!containerEl) return;
    scroller = findScrollParent(containerEl);
    lastTop = NaN;
    lastHeight = NaN;
    stableFrames = 0;
    sampleBand();
    const target: HTMLElement | Window = scroller ?? window;
    const opts = { passive: true };
    // wheel/touchmove cover flings where `scroll` events are throttled.
    target.addEventListener('scroll', pokeSampler, opts);
    target.addEventListener('wheel', pokeSampler, opts);
    target.addEventListener('touchmove', pokeSampler, opts);
    window.addEventListener('resize', pokeSampler, opts);
    return () => {
      target.removeEventListener('scroll', pokeSampler);
      target.removeEventListener('wheel', pokeSampler);
      target.removeEventListener('touchmove', pokeSampler);
      window.removeEventListener('resize', pokeSampler);
      if (bandRafId !== undefined) cancelAnimationFrame(bandRafId);
    };
  });

  const [windowStart, windowEnd] = $derived.by(() => {
    const band = visibleBand;
    const top = band ? band[0] : 0;
    const bandHeight = band ? band[1] - band[0] : Math.min(svgHeight, 1000);
    return getWindowBounds(
      top,
      bandHeight,
      filteredGroups.length,
      height,
      windowOverscan,
      reverseSort,
      descStart,
      pendingGroupCount,
      totalForY,
    );
  });

  // ── Row pool ────────────────────────────────────────────────────────────────
  // A FIXED-size set of row slots reused across scroll instead of a keyed each
  // that creates/destroys rows as the window slides. During scroll the pool size
  // is stable (band height is constant), so slots keep their DOM + component
  // instance and only re-point to a new group — no cloneNode/insert/teardown and
  // far less allocation, which was tripping frequent major GC pauses.
  const POOL_SLACK = 4;
  const poolSize = $derived.by(() => {
    const band = visibleBand;
    const bandHeight = band ? band[1] - band[0] : Math.min(svgHeight, 1000);
    return Math.ceil(bandHeight / height) + 2 * windowOverscan + POOL_SLACK;
  });

  // Slot p shows filteredGroups[windowStart + p], or null past the window/list.
  // poolSize ≥ (windowEnd − windowStart) by construction, so every visible row
  // has a slot. New {i, group} objects per derive are cheap (~poolSize of them);
  // the each is keyed by slot index so the DOM stays put.
  const pool = $derived.by(() => {
    const start = windowStart;
    const total = filteredGroups.length;
    const slots: ({ i: number; group: EventGroups[number] } | null)[] = [];
    for (let p = 0; p < poolSize; p++) {
      const i = start + p;
      slots.push(
        i < windowEnd && i < total ? { i, group: filteredGroups[i] } : null,
      );
    }
    return slots;
  });

  const getY = $derived.by(
    () =>
      (i: number): number =>
        getRowY(i, {
          descStart,
          pendingGroupCount,
          totalForY,
          reverseSort,
          height,
        }),
  );

  // Border rails span the full timeline height so they meet the bottom axis.
  const lineTop = 0;
  const lineBottom = $derived(timelineHeight);
</script>

<div
  id="event-history-timeline-graph"
  class={twMerge(
    'relative overflow-hidden border border-t-0 border-subtle bg-primary',
    error && 'bg-danger',
  )}
  style="height: {svgHeight}px;"
  bind:this={containerEl}
>
  <EndTimeInterval {workflow} {startTime} bind:currentTime={nowMs} let:endTime>
    <div
      class="pointer-events-none sticky top-[120px]"
      class:invisible={!!$activeGroups.length}
    >
      <div class="flex w-full justify-between text-xs">
        <p class="w-60 -translate-x-24 rotate-90">
          {$timestamp(startTime, { format: 'short' })}
        </p>
        <p class="w-60 translate-x-24 rotate-90">
          {$timestamp(endTime, { format: 'short' })}
        </p>
      </div>
    </div>
    <!--
      HTML canvas: a tall positioned layer the page scrolls. Rows/lines/dots are
      plain absolutely-positioned divs; IntersectionObserver decides which rows
      mount, so only windowed rows exist in the DOM despite the canvas being tall.
    -->
    <div
      class="canvas"
      style="width:{canvasWidth}px;height:{svgHeight}px;--dot:{dotSize}px;--dot-r:{dotRadius}px;"
    >
      <!--
        Icon symbol sheet: one hidden <svg> holding every <symbol>. Each icon in
        the tree is a tiny <svg><use href="#ti-…"></svg> — native instancing,
        no {#if} branching, no innerHTML parsing, no repeated path data.
      -->
      <svg class="icon-defs" aria-hidden="true"><TimelineIconDefs /></svg>

      <!-- Border rails -->
      <div
        class="rail"
        style="left:{gutter - radius / 4}px;top:{lineTop}px;width:{radius /
          2}px;height:{lineBottom}px;"
      ></div>
      <div
        class="rail"
        style="left:{canvasWidth -
          gutter -
          radius / 4}px;top:{lineTop}px;width:{radius /
          2}px;height:{lineBottom}px;"
      ></div>

      <TimelineAxis
        x1={gutter - radius / 4}
        x2={canvasWidth - gutter + radius / 4}
        {gutter}
        {timelineHeight}
        {startTime}
        {scale}
      />
      <WorkflowRow {workflow} y={height} length={canvasWidth} />
      {#if !loading}
        <!-- Collapsed segment coords are 0-based; the +gutter offset the SVG got
             from translate(gutter,0) is provided by this anchor's left. -->
        <div class="collapsed-layer" style="left:{gutter}px;">
          <TimelineCollapsedLayer
            {scale}
            {timelineHeight}
            {readOnly}
            onToggle={toggleSegment}
          />
        </div>
      {/if}

      <!--
        POOLED ROWS: the each is keyed by slot INDEX (stable 0..poolSize-1), so
        Svelte never creates/destroys/reorders these <li>s during scroll — it
        just updates each slot's group + top in place. The <li> stays mounted
        even when its slot is null (past the list edge); only the inner row is
        conditionally rendered, so mid-list scrolling causes zero component
        churn. top comes from getRowY (asc formula or descending mirror), and
        shiftFor applies the open-panel offset per slot.
      -->
      <ul class="rows">
        {#each pool as slot, p (p)}
          <li
            class="row-anchor"
            style={slot
              ? `top:${getY(slot.i) - height / 2}px;height:${height}px;${shiftFor(slot.i)}`
              : 'display:none;'}
          >
            {#if slot}
              <TimelineGraphRow
                group={slot.group}
                eventCount={slot.group.eventList.length}
                {canvasWidth}
                project={projectX}
                {readOnly}
              />
            {/if}
          </li>
        {/each}
      </ul>

      {#if loading && pendingGroupCount > 0}
        {@const rectY = getPendingBlockY({
          descStart,
          filteredGroupsLength: filteredGroups.length,
          reverseSort,
          height,
          radius,
        })}
        {@const rectH = pendingGroupCount * height + radius}
        <div
          class="skeleton animate-pulse rounded bg-slate-400/30"
          style="left:{gutter}px;top:{rectY}px;width:{canvasWidth -
            gutter * 2}px;height:{rectH}px;"
        ></div>
      {/if}

      <!--
        Details panel is the last child (paints above rows). onHeight reports the
        real panel height so the transform $effect shifts rows below it. Only
        panelHeight changes — no row attributes touched.
      -->
      {#if !readOnly && activeIdx >= 0}
        {@const grp = filteredGroups[activeIdx]}
        {#if grp}
          {@const panelY = getY(activeIdx) + 1.33 * radius}
          <GroupDetailsRow
            y={panelY}
            group={grp}
            {canvasWidth}
            endTime={workflow?.endTime ? endTime : nowMs}
            onHeight={(h) => {
              panelHeight = h;
            }}
          />
        {/if}
      {/if}
    </div>
  </EndTimeInterval>
</div>

<style lang="postcss">
  /* In-flow (like the old <svg>) so the sticky start/end labels float over it;
     -mt-4 tucks it under the controls border. Positioned so the absolutely
     placed rows/axis resolve against it. */
  .canvas {
    position: relative;
    margin-top: -1rem;
    color: #fff;
  }

  /* Hidden symbol sheet — takes no layout space. */
  .icon-defs {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
  }

  .rail {
    position: absolute;
    background: currentColor;
  }

  /* Zero-size anchor: shifts the collapsed layer's 0-based coords by the gutter,
     mirroring the SVG translate(gutter, 0). */
  .collapsed-layer {
    position: absolute;
    top: 0;
  }

  /* The rows layer covers the whole canvas and paints above the collapsed
     layer, so make it pointer-transparent — only the event buttons opt back in
     (pointer-events:auto) — otherwise it would swallow clicks meant for the
     collapse toggles underneath. */
  .rows {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    pointer-events: none;
  }

  .row-anchor {
    position: absolute;
    left: 0;
    right: 0;
  }

  .skeleton {
    position: absolute;
  }

  /* Connector-line styles for both row components (timeline-graph-row,
     workflow-row). They render `.tl-line` divs in child components, so the
     rules are :global — but namespaced under this component's scoped `.canvas`
     so they don't leak. Each element sets only its geometry + --tl-line-color
     inline; these carry the rest. border-radius: 9999px → pill ends. */
  .canvas :global(.tl-line) {
    border-radius: 9999px;
    background-color: var(--tl-line-color);
  }

  .canvas :global(.tl-line--gradient) {
    background-image: linear-gradient(255deg, #1ff1a5 0%, #f55 100%);
  }

  .canvas :global(.tl-line--dashed) {
    background-color: transparent;
    background-image: repeating-linear-gradient(
      to right,
      var(--tl-line-color) 0 3px,
      transparent 3px 6px
    );
    background-size: 6px 100%;
  }

  .canvas :global(.tl-line--animate) {
    animation: tl-line-dash 60s linear infinite;
  }

  /* -global- so the name isn't scope-hashed; the :global rule above references
     it by its plain name. */
  @keyframes -global-tl-line-dash {
    from {
      background-position-x: 200px;
    }

    to {
      background-position-x: 0;
    }
  }
</style>
