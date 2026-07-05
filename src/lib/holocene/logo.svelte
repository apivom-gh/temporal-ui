<script lang="ts">
  import type { SVGAttributes } from 'svelte/elements';

  import { twMerge as merge } from 'tailwind-merge';

  interface Props extends SVGAttributes<SVGElement> {
    width?: number;
    height?: number;
    class?: string;
  }

  let {
    width = 100,
    height = 100,
    class: className = '',
    ...rest
  }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  role="img"
  viewBox="0 0 100 100"
  {width}
  {height}
  class={merge('fill-current', className)}
  {...rest}
>
  <!-- Apivom Staff brand mark -->
  <polygon points="5.31,5 41.28,95 50.91,95 86.87,5" />
</svg>
