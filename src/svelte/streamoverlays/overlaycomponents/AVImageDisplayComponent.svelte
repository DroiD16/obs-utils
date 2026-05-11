<svelte:options runes={true} />
<script lang='ts'>
	import type { ResolvedValues } from '../../../utils/render.ts';
	import { getRollImageSource } from '../../../utils/rollOverlay.ts';

	const { values, style, componentIndex, componentId }: {
		values: ResolvedValues;
		style: string;
		componentIndex: number;
		componentId?: string;
	} = $props();

	const imageSource = $derived(getRollImageSource(
		String(values.value ?? ''),
		Number(values.obsUtilsTriggerSequence ?? 0),
	));
</script>

<div
	class='component actor-val-component image-component'
	id={`component${componentIndex.toString()}`}
	data-component-id={componentId}
	style={style}
	data-value={String(values.value ?? '')}
>
	<img alt='actor value img renderer' src={imageSource} />
</div>
