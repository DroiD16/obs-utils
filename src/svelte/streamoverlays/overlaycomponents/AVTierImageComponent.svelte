<svelte:options runes={true} />
<script lang='ts'>
	import type { ResolvedValues } from '../../../utils/render.ts';

	const { values, style, componentIndex, componentId }: {
		values: ResolvedValues;
		style: string;
		componentIndex: number;
		componentId?: string;
	} = $props();

	const src = $derived(String(values.value ?? ''));
</script>

<div
	class='component actor-val-component image-component tier-image-component'
	id={`component${componentIndex.toString()}`}
	data-component-id={componentId}
	style={style}
	data-value={src}
	data-pct={String(values.pct ?? '')}
>
	{#if src}
		<img alt='actor value tier img renderer' src={src} />
	{/if}
</div>
