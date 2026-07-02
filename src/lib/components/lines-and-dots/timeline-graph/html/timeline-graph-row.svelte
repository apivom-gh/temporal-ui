<script module lang="ts">
  import { cva } from 'class-variance-authority';

  // Hoisted to module scope: the variant config is prop-independent, so building
  // it once (not per mounted row) keeps it off the virtualized-scroll hot path.
  const groupHover = cva(['h-full w-full border-2'], {
    variants: {
      category: {
        workflow: 'border-blue-700 bg-blue-800/80 ',
        activity: 'border-purple-700 bg-purple-800/80 ',
        'child-workflow': 'border-cyan-600  bg-cyan-600/80 ',
        timer: 'border-yellow-700 bg-yellow-800/80',
        signal: 'border-pink-700 bg-pink-800/80',
        update: 'border-blue-700 bg-blue-800/80',
        other: 'border-slate-700 bg-slate-800/80',
        nexus: 'border-indigo-700 bg-indigo-800/80',
        'local-activity': 'border-slate-700 bg-slate-800/80',
        default: 'border-purple-700 bg-purple-900/80',
      },
    },
  });
</script>

<script lang="ts">
  import PayloadSummary from '$lib/components/payload/payload-summary.svelte';
  import { translate } from '$lib/i18n/translate';
  import type { EventGroup } from '$lib/models/event-groups/event-groups';
  import { setActiveGroup } from '$lib/stores/active-events';
  import {
    decodeLocalActivity,
    getLocalActivityMarkerEvent,
  } from '$lib/utilities/decode-local-activity';
  import type { ValidTime } from '$lib/utilities/format-time';
  import type { SummaryAttribute } from '$lib/utilities/get-single-attribute-for-event';
  import { getEventClassificationLabel } from '$lib/utilities/get-status-label';
  import {
    isActivityTaskScheduledEvent,
    isActivityTaskStartedEvent,
  } from '$lib/utilities/is-event-type';

  import {
    type ColorPair,
    dotBox,
    dotColorPair,
    lineBox,
    strokeColor,
    textColor,
  } from './primitives';
  import {
    CategoryIcon,
    TimelineConfig,
    timelineTextPosition,
  } from '../../constants';
  import type { TimelineIconName } from '../../svg/timeline-icon.svelte';

  type Props = {
    group: EventGroup;
    canvasWidth: number;
    project: (time: ValidTime | undefined | null) => number;
    readOnly: boolean;
    // The group's current event count. Passed as a reactive prop so the row
    // recomputes when events stream in (eventList is mutated in place) and when
    // a pooled row is re-pointed to a different group.
    eventCount?: number;
  };

  let {
    group,
    canvasWidth,
    project,
    readOnly = false,
    eventCount = 0,
  }: Props = $props();

  const { height, gutter, radius } = TimelineConfig;
  const sw = radius * 2; // connector-line thickness
  const DOT_STROKE = 2; // dot border (matches the SVG Dot default)

  const timelineWidth = $derived(canvasWidth - 2 * gutter);
  const pendingActivity = $derived(group?.pendingActivity);

  // Reactive (not untrack) so a re-pointed pooled row relabels for its new group.
  const accessibleName = $derived(
    translate('events.row-accessible-name', {
      eventType: group.displayName,
      classification: getEventClassificationLabel(
        group.finalClassification || group.classification,
      ),
    }),
  );
  const pauseTime = $derived(
    pendingActivity && pendingActivity.pauseInfo?.pauseTime,
  );

  let decodedLocalActivity: SummaryAttribute | undefined = $state(undefined);

  // Keyed on group (not onMount) so it re-runs when a pooled row is re-pointed.
  // Reuses an already-decoded value cached on the group; otherwise decodes once.
  $effect(() => {
    const currentGroup = group;
    decodedLocalActivity = currentGroup.decodedLocalActivity;
    if (currentGroup.category !== 'local-activity') return;
    if (currentGroup.decodedLocalActivity) return;

    const localActivityEvent = getLocalActivityMarkerEvent(currentGroup);
    if (!localActivityEvent) return;

    let cancelled = false;
    decodeLocalActivity(localActivityEvent)
      .then((decoded) => {
        if (cancelled || !decoded) return;
        currentGroup.decodedLocalActivity = decoded;
        decodedLocalActivity = decoded;
      })
      .catch((error) => {
        console.warn('Failed to decode local activity:', error);
      });
    return () => {
      cancelled = true;
    };
  });

  const getDistancePointsAndPositions = (
    timelineWidth: number,
    events: EventGroup['eventList'],
    count: number,
  ) => {
    // Iterate to `count` (= eventCount) rather than slicing first — this both
    // creates the reactive dependency and avoids allocating a throwaway array
    // on every recompute (hot: runs per pooled slot as it re-points on scroll).
    const points: number[] = [];
    const n = Math.min(count, events.length);
    for (let idx = 0; idx < n; idx++) {
      points.push(Math.round(project(events[idx].eventTime)));
    }
    if (pauseTime) {
      points.push(Math.round(project(pauseTime)));
    }
    // textPosition already encodes where the label goes; the label is rendered
    // once (outside the button), so textIndex is no longer needed.
    const { textAnchor, textPosition, backdrop } = timelineTextPosition(
      points,
      height / 2,
      timelineWidth,
      group.isPending,
      TimelineConfig,
    );
    return { points, textAnchor, textPosition, backdrop };
  };

  const { points, textAnchor, textPosition, backdrop } = $derived(
    getDistancePointsAndPositions(timelineWidth, group.eventList, eventCount),
  );

  const onClick = () => {
    if (readOnly) return;
    setActiveGroup(group);
  };

  const activityTaskScheduled = $derived(
    group.eventList.find(isActivityTaskStartedEvent),
  );
  const retryAttempt = $derived(
    activityTaskScheduled?.attributes?.attempt ?? 0,
  );
  const retried = $derived(retryAttempt > 1);

  const lineColor = $derived(
    strokeColor({
      category: group.category,
      classification: group.lastEvent.classification,
    }),
  );
  const showRetryGradient = $derived(
    retried && group.lastEvent.classification === 'Completed',
  );
  const scheduling = $derived(group.lastEvent.classification === 'Completed');

  const pendingLineColor = $derived(
    strokeColor({
      category: pendingActivity
        ? (pendingActivity.attempt ?? 0) > 1
          ? 'retry'
          : 'pending'
        : group.category,
      classification: group.lastEvent.classification,
    }),
  );

  // The button wraps just the dots + connectors (not the whole row). Its bounds
  // are the old hover-highlight region; the highlight is a child shown via the
  // button's native :hover / :focus-visible, so no hover/focus JS state is
  // needed. Coordinates inside the button are button-local (offset by spanLeft).
  const HALO = radius * 1.5;
  // Focus/hover highlight corner radius, concentric with the dots' corners:
  // dot outer corner (radius*0.3 + DOT_STROKE/2) + the gap the highlight extends
  // past the dot edge ((radius*3 - dotOuter)/2) collapses to radius * 0.8.
  const highlightRadius = radius * 0.8;
  const spanLeft = $derived(points[0] - HALO);
  const spanWidth = $derived(
    (group.isPending && canvasWidth - points[0] - HALO) ||
      (points.length >= 2
        ? points[points.length - 1] - points[0] + radius * 3
        : radius * 3),
  );
  const spanCy = HALO; // button-local vertical center
</script>

<!--
  PERF: lines/dots are inline snippets rather than child components — a row with
  N events renders as plain divs with no per-element component instances.
-->
{#snippet connector(
  lx: number,
  rx: number,
  color: string,
  opts: {
    dashed?: boolean;
    animate?: boolean;
    gradient?: boolean;
    dim?: number;
  },
)}
  {@const box = lineBox([lx, spanCy], [rx, spanCy], sw)}
  <div
    class="el tl-line"
    class:tl-line--gradient={opts.gradient}
    class:tl-line--dashed={opts.dashed}
    class:tl-line--animate={opts.animate}
    style="left:{box.left}px;top:{box.top}px;width:{box.width}px;height:{box.height}px;--tl-line-color:{color};{opts.dim
      ? `opacity:${opts.dim};`
      : ''}"
  ></div>
{/snippet}

{#snippet dot(lx: number, pair: ColorPair, icon: TimelineIconName | undefined)}
  {@const box = dotBox(lx, spanCy, radius, DOT_STROKE)}
  <div
    class="el h-[var(--dot)] w-[var(--dot)] rounded-[var(--dot-r)] border-2 border-solid"
    style="left:{box.left}px;top:{box.top}px;border-color:{pair[1]};background:{pair[0]};"
  >
    {#if icon}
      <svg class="icon" viewBox="0 0 24 24"><use href="#ti-{icon}" /></svg>
    {/if}
  </div>
{/snippet}

<div class="row">
  <button
    type="button"
    class="event"
    aria-label={accessibleName}
    disabled={readOnly}
    style="left:{spanLeft}px;top:{height / 2 -
      HALO}px;width:{spanWidth}px;height:{radius * 3}px;"
    onclick={onClick}
  >
    <div
      class="highlight {groupHover({ category: group.category })}"
      style="border-radius:{highlightRadius}px;"
    ></div>
    {#each points as x, index (index)}
      {@const lx = x - spanLeft}
      {@const nextPoint = points[index + 1]}
      {#if nextPoint}
        {@render connector(lx, nextPoint - spanLeft, lineColor, {
          gradient: showRetryGradient,
          dim: scheduling && index === 0 ? 0.35 : undefined,
        })}
      {/if}
      {#if !nextPoint && group.isPending && !pauseTime}
        {@render connector(
          lx,
          canvasWidth - gutter - spanLeft,
          pendingLineColor,
          {
            dashed: true,
            animate: true,
          },
        )}
        {@render dot(lx, dotColorPair(group.lastEvent.classification), 'retry')}
      {/if}
      {@render dot(
        lx,
        dotColorPair(group.eventList[index]?.classification),
        pauseTime && index !== 0
          ? 'pause'
          : decodedLocalActivity
            ? CategoryIcon['local-activity'].name
            : CategoryIcon[group.category].name,
      )}
    {/each}
  </button>

  <!-- Label sits outside the button — informational, not part of the hit target. -->
  <PayloadSummary
    value={group?.userMetadata?.summary}
    prefix={isActivityTaskScheduledEvent(group.initialEvent)
      ? group?.displayName
      : ''}
    fallback={decodedLocalActivity
      ? translate('events.category.local-activity')
      : group?.displayName}
  >
    {#snippet children(decodedValue)}
      {@const iconName =
        (pendingActivity && !pendingActivity.paused) || retried
          ? 'retry'
          : undefined}
      <div
        class="label {textAnchor === 'end' ? 'anchor-end' : ''}"
        style="left:{textPosition[0]}px;top:{textPosition[1]}px;color:{textColor(
          { backdrop, category: group.category },
        )};"
      >
        {#if iconName}
          <svg class="text-icon" viewBox="0 0 24 24"
            ><use href="#ti-{iconName}" /></svg
          >
        {/if}
        <span
          class="text-body"
          class:backdrop
          style={backdrop ? `min-height:${radius * 2}px;` : ''}
        >
          {#if pendingActivity}
            {translate('workflows.attempt')}
            {pendingActivity.attempt} / {pendingActivity.maximumAttempts || '∞'}
            •&nbsp;{decodedValue}
          {:else if retried}
            {retryAttempt} • {decodedValue}
          {:else if decodedLocalActivity}
            {decodedLocalActivity.value}
          {:else}
            {decodedValue}
          {/if}
        </span>
      </div>
    {/snippet}
  </PayloadSummary>
</div>

<style lang="postcss">
  /* Fills the parent row anchor (which owns base Y + panel-shift transform). */
  .row {
    position: absolute;
    inset: 0;
  }

  /* Interactive target: only the dots + connectors between them. Native <button>
     gives keyboard/focus/Enter/Space for free — no hover/focus JS state. */
  .event {
    position: absolute;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    outline: none;

    /* Opt back into pointer events — the .rows layer is pointer-events:none so
       empty row areas pass clicks through to the collapse toggles below. */
    pointer-events: auto;
  }

  .event:disabled {
    cursor: default;
  }

  .highlight {
    position: absolute;
    inset: 0;
    opacity: 0;
    pointer-events: none;
  }

  .event:not(:disabled):hover .highlight,
  .event:not(:disabled):focus-visible .highlight {
    opacity: 1;
  }

  .el {
    position: absolute;
  }

  .icon {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 55%;
    height: 55%;
    transform: translate(-50%, -50%);
    color: #000;
  }

  .label {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 4px;
    transform: translateY(-50%);
    white-space: nowrap;
    user-select: none;
    line-height: 1;
    font-size: 13px;
    pointer-events: none;
  }

  .label.anchor-end {
    transform: translate(-100%, -50%);
    flex-direction: row-reverse;
  }

  .text-icon {
    width: 14px;
    height: 14px;
    color: currentColor;
  }

  .text-body.backdrop {
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    border-radius: 9999px;
    background: #141414;
    color: #fff;
  }
</style>
