import { SvelteSet } from 'svelte/reactivity';

import type { EventGroups } from '$lib/models/event-groups/event-groups';
import type { WorkflowEvents } from '$lib/types/events';
import type { WorkflowExecution } from '$lib/types/workflows';
import { isWorkflowDelayed } from '$lib/utilities/delayed-workflows';
import { validTimeToDate } from '$lib/utilities/format-time';
import { isNotNullish } from '$lib/utilities/type-predicates';

import { Timespan } from './timespan';
import type { TimeSegment, TimeSegmentKey } from './types';
import { buildTimeSegments } from './utils/build-time-segments';

const DEFAULT_DURATION_THRESHOLD_RATIO = 0.1;

interface TimelineInit {
  getFullEventHistory: () => WorkflowEvents;
  getWorkflow: () => WorkflowExecution;
  getEventGroups: () => EventGroups;
  getCurrentTimeMs: () => number;
  getDurationThresholdRatio?: () => number;
}

export class Timeline {
  #collapsedSegmentKeys = new SvelteSet<TimeSegmentKey>();
  #hasUserToggled = false;

  #getFullEventHistory: () => WorkflowEvents;
  #getWorkflow: () => WorkflowExecution;
  #getEventGroups: () => EventGroups;
  #getCurrentTimeMs: () => number;
  #getDurationThresholdRatio: () => number;

  constructor({
    getFullEventHistory,
    getWorkflow,
    getEventGroups,
    getCurrentTimeMs,
    getDurationThresholdRatio,
  }: TimelineInit) {
    this.#getFullEventHistory = getFullEventHistory;
    this.#getWorkflow = getWorkflow;
    this.#getEventGroups = getEventGroups;
    this.#getCurrentTimeMs = getCurrentTimeMs;
    this.#getDurationThresholdRatio =
      getDurationThresholdRatio ?? (() => DEFAULT_DURATION_THRESHOLD_RATIO);
  }

  readonly workflow = $derived.by(() => this.#getWorkflow());
  readonly eventGroups = $derived.by(() => this.#getEventGroups());
  private readonly _endUnbounded = $derived(!this.workflow.endTime);

  private readonly _endMs = $derived.by(() => {
    const end = this.workflow.endTime ?? this.#getCurrentTimeMs();
    return validTimeToDate(end).getTime();
  });

  private readonly _startMs = $derived.by(() => {
    // Event history is ordered ascending by event time, so the earliest event
    // is the first entry — no need to map and scan the whole array.
    const firstEventTime = this.#getFullEventHistory()[0]?.eventTime;

    const startCandidates = [
      firstEventTime,
      this.workflow.executionTime,
    ].filter(isNotNullish);

    const earliestStartTime = startCandidates.length
      ? Math.min(
          ...startCandidates.map((time) => validTimeToDate(time).getTime()),
        )
      : undefined;

    const start =
      (isWorkflowDelayed(this.workflow) && this.workflow.startTime
        ? this.workflow.startTime
        : earliestStartTime) ??
      this.workflow.startTime ??
      this._endMs;

    return Math.min(validTimeToDate(start).getTime(), this._endMs);
  });

  // Split into primitive deriveds so the Timespan is only reconstructed when a
  // boundary actually changes. Streaming in more events reruns _startMs (O(1)),
  // but an unchanged number won't propagate, so segments and everything
  // downstream stay cached.
  readonly workflowTimespan = $derived.by(
    () =>
      new Timespan(this._startMs, this._endMs, {
        endUnbounded: this._endUnbounded,
      }),
  );

  readonly segments = $derived.by<TimeSegment[]>(() => {
    return buildTimeSegments({
      workflowTimespan: this.workflowTimespan,
      eventGroups: this.eventGroups,
    });
  });

  // Uses raw set membership, not isTimeSegmentCollapsed, for two reasons:
  // isTimeSegmentCollapsible reads expandedDurationMs, so the guarded check
  // would be circular; and excluding every intended-collapsed segment (even
  // ones temporarily too small to collapse) keeps the denominator stable so
  // expanding one large gap can't cascade borderline gaps open.
  readonly expandedDurationMs = $derived.by(() =>
    this.segments.reduce(
      (sum, segment) =>
        this.#isSegmentCollapsedRaw(segment)
          ? sum
          : sum + segment.timespan.durationMs,
      0,
    ),
  );

  #isSegmentCollapsedRaw(segment: TimeSegment): boolean {
    return this.#collapsedSegmentKeys.has(segment.timespan.key);
  }

  isTimeSegmentCollapsible(segment: TimeSegment): boolean {
    if (segment.kind !== 'inactive') return false;
    if (this.segments.length <= 1) return false;
    if (this.expandedDurationMs <= 0) return false;

    return (
      segment.timespan.durationMs / this.expandedDurationMs >=
      this.#getDurationThresholdRatio()
    );
  }

  isTimeSegmentCollapsed(segment: TimeSegment): boolean {
    return (
      this.#isSegmentCollapsedRaw(segment) &&
      this.isTimeSegmentCollapsible(segment)
    );
  }

  readonly collapsibleSegments = $derived(
    this.segments.filter((segment) => this.isTimeSegmentCollapsible(segment)),
  );

  readonly hasCollapsibleSegments = $derived(
    this.collapsibleSegments.length > 0,
  );

  readonly allCollapsibleSegmentsCollapsed = $derived(
    this.hasCollapsibleSegments &&
      this.collapsibleSegments.every((segment) =>
        this.isTimeSegmentCollapsed(segment),
      ),
  );

  toggleTimeSegment(segment: TimeSegment): void {
    this.#hasUserToggled = true;
    const key = segment.timespan.key;
    if (this.#collapsedSegmentKeys.has(key)) {
      this.#collapsedSegmentKeys.delete(key);
    } else {
      this.#collapsedSegmentKeys.add(key);
    }
  }

  expandAllSegments(): void {
    this.#hasUserToggled = true;
    this.#collapsedSegmentKeys.clear();
  }

  collapseAllSegments(): void {
    this.#hasUserToggled = true;
    this.#collapseAllSegments();
  }

  collapseAllSegmentsByDefault(): void {
    if (this.#hasUserToggled) return;
    this.#collapseAllSegments();
  }

  #collapseAllSegments(): void {
    // purposefully not setting this.#hasUserToggled = true
    // here. Only public facing methods should set flag.
    let collapsed = true;

    // This is a while loop because collapsing segments shrinks the expanded
    // duration, which can push additional segments past the threshold.
    while (collapsed) {
      collapsed = false;
      for (const segment of this.segments) {
        const key = segment.timespan.key;
        if (this.#collapsedSegmentKeys.has(key)) continue;
        if (this.isTimeSegmentCollapsible(segment)) {
          this.#collapsedSegmentKeys.add(key);
          collapsed = true;
        }
      }
    }
  }
}
