<script lang="ts">
  import { translate } from '$lib/i18n/translate';
  import type { WorkflowExecution } from '$lib/types/workflows';
  import { isWorkflowDelayed } from '$lib/utilities/delayed-workflows';
  import { getWorkflowStatusLabel } from '$lib/utilities/get-status-label';

  import { dotBox, lineBox } from './primitives';
  import { dotColors, strokeColor, TimelineConfig } from '../constants';

  interface Props {
    workflow: WorkflowExecution;
    length: number;
    y: number;
  }

  let { workflow, length, y }: Props = $props();

  const { radius, height, gutter } = TimelineConfig;
  const sw = radius * 2; // connector-line thickness
  const DOT_STROKE = 2; // dot border (matches the SVG Dot default)
  const cy = height / 2;

  const start = $derived(gutter);
  const end = $derived(start + length - 2 * gutter);
  const box = $derived(lineBox([start, cy], [end, cy], sw));
  const color = $derived(
    strokeColor({
      status: workflow.status,
      delayed: isWorkflowDelayed(workflow),
    }),
  );
  const colors = $derived(dotColors(workflow.status));

  const accessibleName = $derived(
    translate('workflows.row-accessible-name', {
      workflowId: workflow.id,
      status: getWorkflowStatusLabel(workflow.status),
    }),
  );
</script>

<!-- Informational bar, not interactive (no handler) → role="img" with a label,
     not a button. pointer-events-none keeps it clear of the collapse toggles
     underneath. -->
<div
  role="img"
  aria-label={accessibleName}
  class="pointer-events-none absolute inset-x-0 outline-none"
  style="top:{y - cy}px;height:{height}px;"
>
  <div
    class="tl-line absolute"
    class:tl-line--dashed={workflow.isRunning}
    class:tl-line--animate={workflow.isRunning}
    style="left:{box.left}px;top:{box.top}px;width:{box.width}px;height:{box.height}px;--tl-line-color:{color};"
  ></div>
  {#each [start, end] as x (x)}
    {@const dbox = dotBox(x, cy, radius, DOT_STROKE)}
    <div
      class="absolute h-[var(--dot)] w-[var(--dot)] rounded-[var(--dot-r)] border-2 border-solid"
      style="left:{dbox.left}px;top:{dbox.top}px;border-color:{colors.stroke};background:{colors.fill};"
    >
      <svg
        class="absolute left-1/2 top-1/2 h-[55%] w-[55%] -translate-x-1/2 -translate-y-1/2 text-black"
        viewBox="0 0 24 24"><use href="#ti-workflow" /></svg
      >
    </div>
  {/each}
</div>
