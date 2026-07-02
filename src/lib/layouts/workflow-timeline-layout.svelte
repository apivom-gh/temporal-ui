<script lang="ts">
  import { getContext, onMount } from 'svelte';

  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';

  import EventHistoryLegend from '$lib/components/lines-and-dots/event-history-legend.svelte';
  import EventTypeFilter from '$lib/components/lines-and-dots/event-type-filter.svelte';
  import TimelineGraph from '$lib/components/lines-and-dots/timeline-graph/timeline-graph.svelte';
  import type { Timeline } from '$lib/components/lines-and-dots/timeline-graph/timeline.svelte';
  import WorkflowError from '$lib/components/lines-and-dots/workflow-error.svelte';
  import DownloadEventHistoryModal from '$lib/components/workflow/download-event-history-modal.svelte';
  import InputAndResults from '$lib/components/workflow/input-and-results.svelte';
  import WorkflowCallbacks from '$lib/components/workflow/workflow-callbacks.svelte';
  import {
    HISTORY_CTX,
    type HistoryContext,
  } from '$lib/contexts/history-context';
  import ToggleButton from '$lib/holocene/toggle-button/toggle-button.svelte';
  import ToggleButtons from '$lib/holocene/toggle-button/toggle-buttons.svelte';
  import { translate } from '$lib/i18n/translate';
  import type { EventGroup } from '$lib/models/event-groups/event-groups';
  import {
    enrichGroups,
    getWorkflowTaskFailedEvent as getBufferWftFailedEvent,
    getGroupArray,
    onLatestGroup,
  } from '$lib/services/grouped-event-buffer';
  import { clearActives } from '$lib/stores/active-events';
  import { collapseIdleTime, eventFilterSort } from '$lib/stores/event-view';
  import { pauseLiveUpdates } from '$lib/stores/events';
  import { eventTypeFilter } from '$lib/stores/filters';
  import { workflowRun } from '$lib/stores/workflow-run';
  import type {
    WorkflowTaskFailedEvent,
    WorkflowTaskTimedOutEvent,
  } from '$lib/types/events';
  import {
    parseEventFilterParams,
    updateEventFilterParams,
  } from '$lib/utilities/event-filter-params';
  import { getTimelineGroups } from '$lib/utilities/sort-timeline-groups';

  const historyCtx = getContext<HistoryContext>(HISTORY_CTX);

  const namespace = $derived(page.params.namespace);
  const workflow = $derived($workflowRun.workflow);

  const urlParams = $derived(parseEventFilterParams(page.url));
  $effect(() => {
    $eventFilterSort = urlParams.sort;
    $pauseLiveUpdates = urlParams.refresh_off;
  });

  const onAutoRefreshToggle = () => {
    updateEventFilterParams(
      page.url,
      { refresh_off: !$pauseLiveUpdates },
      goto,
    );
  };

  const reverseSort = $derived($eventFilterSort === 'descending');

  let bufferGroups = $state<EventGroup[]>([]);

  const filteredBufferGroups = $derived.by(() => {
    const active = $eventTypeFilter;
    return bufferGroups.filter((g) => active.includes(g.category));
  });

  const groups = $derived(
    getTimelineGroups(
      filteredBufferGroups,
      reverseSort,
      historyCtx.fetchComplete,
      historyCtx.descMinId,
    ),
  );

  const workflowTaskFailedError = $derived(
    historyCtx.fetchComplete
      ? (getBufferWftFailedEvent() as
          | WorkflowTaskFailedEvent
          | WorkflowTaskTimedOutEvent
          | undefined)
      : undefined,
  );

  const isNotPending = $derived(
    Boolean(workflow && !workflow?.isRunning && !workflow?.isPaused),
  );

  beforeNavigate(() => {
    clearActives();
  });

  let showDownloadPrompt = $state(false);

  const onSort = () => {
    const newSort = reverseSort ? 'ascending' : 'descending';
    updateEventFilterParams(page.url, { sort: newSort }, goto);
  };

  // ── Dedicated timeline scroll container ────────────────────────────────────
  // The timeline scrolls inside its own overflow-y container, so the
  // container's scrollTop *is* the pan amount — no page-offset sentinel, no
  // spacer-vs-page bookkeeping, no re-measuring when content above shifts.
  // TimelineGraph keeps its translateY compositor model; we just feed it
  // scrollTop and the container's height.
  let scrollEl = $state<HTMLDivElement | null>(null);
  let viewportHeight = $state(0);
  let timelineScrollY = $state(0);
  let controlsHeight = $state(0);
  let scrollDirty = false;

  // Space below the bottom axis for the rotated x-axis tick labels. Part of the
  // scrollable content height so the labels always scroll fully into view.
  const AXIS_LABEL_ZONE_PX = 150;

  // Actual drawn height of the timeline, reported by TimelineGraph. The scroll
  // content is exactly this plus the label zone, so the gap below the axis is
  // always the label zone — no cross-component estimate to drift.
  let graphContentHeight = $state(0);
  const scrollContentHeight = $derived(
    Math.max(graphContentHeight, 120) + AXIS_LABEL_ZONE_PX,
  );
  // Bound the scroll container to the viewport with an explicit dvh-based
  // max-height. This is what makes it the scroll region (its clientHeight is the
  // visible viewport, so getWindowBounds virtualizes correctly). flex-1 can't do
  // this here — the app-shell column it lives in is percentage-height against an
  // auto-height <main>, so it isn't a definite height for flex to divide.
  const viewportMaxHeight = $derived(
    `calc(100dvh - var(--top-nav-height, 3rem) - ${controlsHeight}px)`,
  );

  const estimatedTotalGroups = $derived.by(() => {
    if (historyCtx.fetchComplete) return groups.length;
    const totalEvents = historyCtx.totalExpectedEvents ?? 0;
    return Math.max(groups.length, Math.ceil(totalEvents * 0.5));
  });

  onMount(() => {
    historyCtx.resume();
    bufferGroups = getGroupArray({ excludeWorkflowTasks: true });

    // Scroll tracking: the container's onscroll handler only flips scrollDirty
    // (zero layout reads / Svelte writes in the handler). This RAF tick reads
    // scrollTop once per frame and writes it straight through as the pan — the
    // scroll container's scrollTop IS the timeline offset, no math required.
    let lastScrollTop = -1;
    let rafId = 0;
    const tick = () => {
      if (scrollDirty && scrollEl) {
        scrollDirty = false;
        const top = scrollEl.scrollTop;
        if (top !== lastScrollTop) {
          lastScrollTop = top;
          timelineScrollY = top;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    // Throttle buffer → Svelte updates to at most once per animation frame.
    // onLatestGroup fires for every new group head (~N times during load),
    // each triggering getGroupArray() (O(N log N) sort) + full Svelte
    // reactive cascade. Batching via rAF reduces that to ≤60 updates/sec
    // regardless of how fast the bidirectional cursors push data.
    let groupUpdatePending = false;
    const unsub = onLatestGroup(() => {
      if (!groupUpdatePending) {
        groupUpdatePending = true;
        requestAnimationFrame(() => {
          groupUpdatePending = false;
          bufferGroups = getGroupArray({ excludeWorkflowTasks: true });
        });
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
      unsub();
    };
  });

  $effect(() => {
    if (historyCtx.fetchComplete) {
      enrichGroups(
        $workflowRun.workflow?.pendingActivities ?? [],
        $workflowRun.workflow?.pendingNexusOperations ?? [],
      );
      bufferGroups = getGroupArray({ excludeWorkflowTasks: true });
    }
  });

  let timeline = $state<Timeline>();

  const handleTimelineInit = (t: Timeline) => {
    timeline = t;
  };

  // Defer the default collapse until the history fetch finishes. Segments are
  // derived from the streaming event list, so collapsing mid-stream makes the
  // idle-time zigzag appear and shift as partial-data gaps resolve. Waiting for
  // fetchComplete collapses once against the final, stable segment set.
  $effect(() => {
    if (timeline && historyCtx.fetchComplete && $collapseIdleTime === 'on') {
      timeline.collapseAllSegmentsByDefault();
    }
  });

  const onToggleIdleTime = () => {
    if (!timeline) return;
    if (timeline.allCollapsibleSegmentsCollapsed) {
      timeline.expandAllSegments();
      $collapseIdleTime = 'off';
    } else {
      timeline.collapseAllSegments();
      $collapseIdleTime = 'on';
    }
  };
</script>

<InputAndResults />
<div class="flex flex-col gap-2">
  {#if workflowTaskFailedError}
    <WorkflowError
      error={workflowTaskFailedError}
      pendingTask={workflow?.pendingWorkflowTask}
    />
  {/if}
  {#if workflow?.callbacks?.length}
    <WorkflowCallbacks callbacks={workflow.callbacks} />
  {/if}
</div>

<!--
  Wrapper: single flex child so the parent's gap-4 only applies once (above
  this block). Internally the controls bar and the scroll container are in
  normal block flow with no gaps, so they sit flush.
-->
<div>
  <div
    class="surface-background sticky top-0 z-[11] flex flex-wrap items-center justify-between gap-2 border-b border-subtle pb-2 md:top-[var(--top-nav-height)] md:pt-2 xl:gap-8"
    bind:clientHeight={controlsHeight}
  >
    <div class="flex items-center gap-2">
      <h2>{translate('workflows.timeline-tab')}</h2>
      <EventHistoryLegend />
    </div>
    <div class="flex items-center gap-2">
      <ToggleButtons>
        <ToggleButton
          leadingIcon={reverseSort ? 'descending' : 'ascending'}
          data-testid="zoom-in"
          on:click={onSort}
          size="sm">{reverseSort ? 'Descending' : 'Ascending'}</ToggleButton
        >
        <ToggleButton
          leadingIcon="timeline-collapse"
          data-testid="toggle-idle-time"
          loading={!historyCtx.fetchComplete}
          disabled={!historyCtx.fetchComplete ||
            !timeline?.hasCollapsibleSegments}
          on:click={onToggleIdleTime}
          size="sm"
        >
          {timeline?.allCollapsibleSegmentsCollapsed
            ? translate('workflows.show-idle-time')
            : translate('workflows.hide-idle-time')}
        </ToggleButton>
        <EventTypeFilter compact={false} />
        <ToggleButton
          disabled={isNotPending}
          data-testid="pause"
          class="border-l-0"
          size="sm"
          on:click={onAutoRefreshToggle}
        >
          <span
            class="h-1.5 w-1.5 rounded-full {$pauseLiveUpdates || isNotPending
              ? 'bg-slate-300'
              : 'bg-green-600'}"
          ></span>
          {$pauseLiveUpdates || isNotPending
            ? translate('workflows.auto-refresh-off')
            : translate('workflows.auto-refresh-on')}
        </ToggleButton>
        <ToggleButton
          data-testid="download"
          leadingIcon="download"
          size="sm"
          on:click={() => (showDownloadPrompt = true)}
        >
          {translate('common.download')}
        </ToggleButton>
      </ToggleButtons>
    </div>
  </div>

  <!--
  Dedicated scroll container: its own scrollTop is the timeline pan, so no
  page-offset measurement is needed. The dvh-based max-height bounds it to the
  viewport so it (not the page) is the scroll region — which is what keeps
  virtualization working: its clientHeight is the visible height fed to
  getWindowBounds. The tall inner element supplies the scroll range; the sticky
  wrapper is the pinned viewport TimelineGraph pans within (translateY
  compositor model). border-t supplies the border timeline-graph omits.
-->
  <div
    class="relative overflow-y-auto overflow-x-hidden border-t border-subtle"
    style="max-height: {viewportMaxHeight};"
    bind:this={scrollEl}
    bind:clientHeight={viewportHeight}
    onscroll={() => (scrollDirty = true)}
  >
    {#if workflow}
      <div style="height: {scrollContentHeight}px;">
        <div class="sticky top-0" style="height: {viewportHeight}px;">
          <TimelineGraph
            {workflow}
            {groups}
            {reverseSort}
            loading={!historyCtx.fetchComplete}
            scrollY={timelineScrollY}
            {viewportHeight}
            totalExpectedEvents={estimatedTotalGroups}
            descMinId={historyCtx.descMinId}
            error={Boolean(workflowTaskFailedError)}
            bind:contentHeight={graphContentHeight}
            onTimelineInit={handleTimelineInit}
          />
        </div>
      </div>
    {/if}
  </div>
</div>
<!-- end wrapper -->

{#if workflow}
  <DownloadEventHistoryModal
    bind:open={showDownloadPrompt}
    {namespace}
    workflowId={workflow.id}
    runId={workflow.runId}
  />
{/if}
