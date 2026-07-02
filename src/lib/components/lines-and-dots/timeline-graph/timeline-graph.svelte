<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';

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
  import Line from '../svg/line.svelte';
  import TimelineIconDefs from '../svg/timeline-icon-defs.svelte';
  import {
    getDescStart,
    getPendingBlockY,
    getRowY,
    getTotalForY,
  } from '../svg/timeline-positioning';

  import GroupDetailsRow from './group-details-row.svelte';
  import TimelineAxis from './timeline-axis.svelte';
  import TimelineCollapsedLayer from './timeline-collapsed-layer.svelte';
  import TimelineGraphRow from './timeline-graph-row.svelte';
  import { TimelineScale } from './timeline-scale.svelte';
  import { Timeline } from './timeline.svelte';
  import { Viewport } from './viewport.svelte';
  import WorkflowRow from './workflow-row.svelte';

  interface Props {
    x?: number;
    y?: number;
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
    x = 0,
    y = 0,
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

  // Scroll-window virtualization: only the rows within OVERSCAN rows of the
  // current viewport are mounted in the SVG DOM. The SVG viewBox handles
  // per-frame visual panning; this derived controls which <g> elements exist.
  //
  // OVERSCAN = 8 rows × 24 px = 192 px buffer per side. Rows are cheap
  // (icon + text only, no long connector lines) so a small buffer is enough.
  const OVERSCAN = 8;

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

  // PERF IMPERATIVE TRANSFORM APPROACH:
  // A plain Map of group-id → SVG <g> wrapper element, populated by the
  // use:registerRow action on each row. Not reactive — Svelte never observes
  // this Map, so registering/deregistering rows causes no reactive cascade.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const rowWrappers = new Map<string, SVGGElement>();

  function registerRow(el: SVGGElement, id: string) {
    rowWrappers.set(id, el);
    return {
      destroy() {
        rowWrappers.delete(id);
      },
    };
  }

  // PERF: This $effect subscribes only to activeIdx, panelHeight, and
  // groupIndexMap (which changes when filteredGroups changes). It never makes
  // individual rows reactive to $activeGroups.
  //
  // On click: one JS loop over the ~33 registered row wrappers (17 visible +
  // 8 overscan per side) + one setAttribute/removeAttribute per row that
  // actually changes its transform. No component destroy/recreate, no cache
  // clearing, no onMount re-runs. Imperative Map iteration is uniformly cheaper
  // than letting Svelte propagate $activeGroups through a per-row derived.
  $effect(() => {
    const idx = activeIdx;
    const shift = panelHeight;
    const idxMap = groupIndexMap; // reactive dep so effect re-runs on filter changes
    // PERF SORT: reverseSort flips which side of activeIdx receives the shift.
    // In ascending mode rows AFTER (i > idx) move down. In descending mode
    // rows BEFORE (i < idx) are visually below the panel and move down instead.
    const isDesc = reverseSort;
    // Re-run when the scroll window shifts and new rows mount so they receive
    // the correct transform immediately rather than appearing at y=0.
    const _ws = windowStart;
    const _we = windowEnd;

    if (idx < 0) {
      for (const el of rowWrappers.values()) {
        el.removeAttribute('transform');
      }
      return;
    }

    if (shift === 0) return;

    for (const [id, el] of rowWrappers) {
      const i = idxMap.get(id);
      if (i === undefined) continue;
      if (isDesc ? i < idx : i > idx) {
        el.setAttribute('transform', `translate(0, ${shift})`);
      } else {
        el.removeAttribute('transform');
      }
    }
  });

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

  // ── IntersectionObserver virtualization ────────────────────────────────────
  // Because the SVG scrolls with the page (no bounded container to read
  // scrollTop/clientHeight from), invisible sentinels spaced every
  // SENTINEL_BLOCK_PX down the content report — via an IntersectionObserver
  // rooted at the viewport — which pixel bands are near view. Their union is fed
  // to the existing getWindowBounds math (asc/desc/pending aware) so only rows
  // in view (+ rootMargin overscan) mount. rootMargin is the scroll overscan.
  const SENTINEL_BLOCK_PX = 800;
  const SENTINEL_ROOT_MARGIN = '400px';
  const sentinelCount = $derived(
    Math.max(1, Math.ceil(svgHeight / SENTINEL_BLOCK_PX)),
  );

  const visibleBlocks = new SvelteSet<number>();
  // Created eagerly (SSR-guarded) so sentinels can self-observe in their action,
  // which runs during mount — before any $effect would. Disconnected on unmount.
  const sentinelObserver =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const block = Number(entry.target.getAttribute('data-block'));
              if (entry.isIntersecting) {
                visibleBlocks.add(block);
              } else {
                visibleBlocks.delete(block);
              }
            }
          },
          { root: null, rootMargin: SENTINEL_ROOT_MARGIN },
        );

  $effect(() => () => sentinelObserver?.disconnect());

  function observeSentinel(node: HTMLElement, block: number) {
    let current = block;
    node.dataset.block = String(current);
    sentinelObserver?.observe(node);
    return {
      update(next: number) {
        current = next;
        node.dataset.block = String(current);
      },
      destroy() {
        sentinelObserver?.unobserve(node);
        visibleBlocks.delete(current);
      },
    };
  }

  // Visible pixel band from the intersecting sentinels. null until the observer
  // first reports — the initial paint falls back to the top of the timeline.
  const visibleBand = $derived.by<[number, number] | null>(() => {
    if (!visibleBlocks.size) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const block of visibleBlocks) {
      if (block < min) min = block;
      if (block > max) max = block;
    }
    return [min * SENTINEL_BLOCK_PX, (max + 1) * SENTINEL_BLOCK_PX];
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

  const windowedGroups = $derived(filteredGroups.slice(windowStart, windowEnd));

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
  <!--
    IntersectionObserver virtualization sentinels: invisible pixel bands that
    report (against the viewport) which part of the page-scrolled timeline is in
    view, so only the rows near it mount. Purely for measurement — no visuals.
  -->
  <div class="pointer-events-none absolute inset-0" aria-hidden="true">
    {#each Array(sentinelCount) as _, block (block)}
      <div
        class="absolute left-0 w-px"
        style="top: {block *
          SENTINEL_BLOCK_PX}px; height: {SENTINEL_BLOCK_PX}px;"
        use:observeSentinel={block}
      ></div>
    {/each}
  </div>
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
      The <svg> is the full timeline height and scrolls with the page — no
      translateY. Rows render at their absolute y; the page reveals the visible
      portion natively, and IntersectionObserver decides which rows are mounted.
      Only windowed rows exist in the DOM, so the SVG stays light despite being
      tall.
    -->
    <svg
      {x}
      {y}
      viewBox="0 0 {canvasWidth} {svgHeight}"
      height={svgHeight}
      width={canvasWidth}
      overflow="visible"
      class="-mt-4"
    >
      <!--
        PERF: Defines all 11 timeline icon <symbol> elements once per SVG.
        Every <TimelineIcon> is a single <use href="#ti-{name}"> node — no
        {#if} branching, no innerHTML parsing, no repeated path data in the DOM.
        The browser caches the symbol geometry; rendering cost per icon is minimal.
      -->
      <TimelineIconDefs />
      <Line
        startPoint={[gutter, lineTop]}
        endPoint={[gutter, lineBottom]}
        strokeWidth={radius / 2}
      />
      <Line
        startPoint={[canvasWidth - gutter, lineTop]}
        endPoint={[canvasWidth - gutter, lineBottom]}
        strokeWidth={radius / 2}
      />
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
        <g transform="translate({gutter}, 0)">
          <TimelineCollapsedLayer
            {scale}
            {timelineHeight}
            {readOnly}
            onToggle={toggleSegment}
          />
        </g>
      {/if}

      <!--
        PERF IMPERATIVE TRANSFORM APPROACH:
        Single {#each} loop — rows are never destroyed/recreated on click.
        Each row's <g> wrapper is registered in rowWrappers via use:registerRow.
        The $effect in <script> iterates those refs and stamps transform
        attributes directly when activeIdx or panelHeight changes.

        Cost on click: O(N) Map iteration + N-K setAttribute calls (compositor
        path, no layout pass). No component lifecycle operations at all.
        Uniformly fast for both top and bottom clicks.
      -->
      <!--
        PERF SORT: rows always iterate in ascending key order — Svelte never
        reorders DOM nodes when sort changes. y is computed from the loop index
        using the ascending formula (i+2)*height or the descending mirror
        (totalForY+1-i)*height so that the visual order flips without any
        insertBefore. totalForY = filteredGroups.length + pendingGroupCount keeps
        all existing rows at a stable y as new data streams in: pendingGroupCount
        shrinks as filteredGroups grows, so totalForY ≈ constant throughout.
        The transform $effect handles the panel-shift side; it already accounts
        for reverseSort by checking (i < idx) instead of (i > idx).
      -->
      {#each windowedGroups as group, localI (group.id)}
        {@const i = windowStart + localI}
        {@const y = getY(i)}
        <g use:registerRow={group.id}>
          <!--
            PERF: Key on group.eventList.length so Svelte only re-renders
            this row when new events are appended to the group. Frozen to 0
            during loading to prevent destroy+recreate on every streaming
            batch — after loading, individual live-event arrivals are fine.
          -->
          {#key loading ? 0 : group.eventList.length}
            <TimelineGraphRow
              {y}
              {group}
              {canvasWidth}
              project={projectX}
              {readOnly}
            />
          {/key}
        </g>
      {/each}

      {#if loading && pendingGroupCount > 0}
        {@const rectY = getPendingBlockY({
          descStart,
          filteredGroupsLength: filteredGroups.length,
          reverseSort,
          height,
          radius,
        })}
        {@const rectH = pendingGroupCount * height + radius}
        <rect
          x={gutter}
          y={rectY}
          width={canvasWidth - gutter * 2}
          height={rectH}
          rx="4"
          class="animate-pulse fill-slate-400/30"
        />
      {/if}

      <!--
        Details panel sits above all rows in SVG paint order (last child = top).
        onHeight delivers the actual panel height back so the $effect can update
        transforms. Only panelHeight changes — no row attributes touched.
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
    </svg>
  </EndTimeInterval>
</div>
