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
  private _collapsedSegmentKeys = new SvelteSet<TimeSegmentKey>();
  private _hasUserToggled = false;

  private _getFullEventHistory: () => WorkflowEvents;
  private _getWorkflow: () => WorkflowExecution;
  private _getEventGroups: () => EventGroups;
  private _getCurrentTimeMs: () => number;
  private _getDurationThresholdRatio: () => number;

  constructor({
    getFullEventHistory,
    getWorkflow,
    getEventGroups,
    getCurrentTimeMs,
    getDurationThresholdRatio,
  }: TimelineInit) {
    this._getFullEventHistory = getFullEventHistory;
    this._getWorkflow = getWorkflow;
    this._getEventGroups = getEventGroups;
    this._getCurrentTimeMs = getCurrentTimeMs;
    this._getDurationThresholdRatio =
      getDurationThresholdRatio ?? (() => DEFAULT_DURATION_THRESHOLD_RATIO);
  }

  readonly workflow = $derived.by(() => this._getWorkflow());
  readonly eventGroups = $derived.by(() => this._getEventGroups());
  private readonly _endUnbounded = $derived(!this.workflow.endTime);

  private readonly _endMs = $derived.by(() => {
    const end = this.workflow.endTime ?? this._getCurrentTimeMs();
    return validTimeToDate(end).getTime();
  });

  private readonly _startMs = $derived.by(() => {
    // Event history is ordered ascending by event time, so the earliest event
    // is the first entry — no need to map and scan the whole array.
    const firstEventTime = this._getFullEventHistory()[0]?.eventTime;

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
        this._isSegmentCollapsedRaw(segment)
          ? sum
          : sum + segment.timespan.durationMs,
      0,
    ),
  );

  private _isSegmentCollapsedRaw(segment: TimeSegment): boolean {
    return this._collapsedSegmentKeys.has(segment.timespan.key);
  }

  isTimeSegmentCollapsible(segment: TimeSegment): boolean {
    if (segment.kind !== 'inactive') return false;
    if (this.segments.length <= 1) return false;
    if (this.expandedDurationMs <= 0) return false;

    return (
      segment.timespan.durationMs / this.expandedDurationMs >=
      this._getDurationThresholdRatio()
    );
  }

  isTimeSegmentCollapsed(segment: TimeSegment): boolean {
    return (
      this._isSegmentCollapsedRaw(segment) &&
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
    this._hasUserToggled = true;
    const key = segment.timespan.key;
    if (this._collapsedSegmentKeys.has(key)) {
      this._collapsedSegmentKeys.delete(key);
    } else {
      this._collapsedSegmentKeys.add(key);
    }
  }

  expandAllSegments(): void {
    this._hasUserToggled = true;
    this._collapsedSegmentKeys.clear();
  }

  collapseAllSegments(): void {
    this._hasUserToggled = true;
    this._collapseAllSegments();
  }

  collapseAllSegmentsByDefault(): void {
    if (this._hasUserToggled) return;
    this._collapseAllSegments();
  }

  private _collapseAllSegments(): void {
    // purposefully not setting this._hasUserToggled = true
    // here. Only public facing methods should set flag.
    let collapsed = true;

    // This is a while loop because collapsing segments shrinks the expanded
    // duration, which can push additional segments past the threshold.
    while (collapsed) {
      collapsed = false;
      for (const segment of this.segments) {
        const key = segment.timespan.key;
        if (this._collapsedSegmentKeys.has(key)) continue;
        if (this.isTimeSegmentCollapsible(segment)) {
          this._collapsedSegmentKeys.add(key);
          collapsed = true;
        }
      }
    }
  }
}
