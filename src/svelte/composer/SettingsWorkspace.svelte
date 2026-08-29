<svelte:options runes={true} />
<script lang='ts'>
	import type { OverlayTrack } from '../../utils/overlayAnimation.ts';
	import type { OverlayData, OverlayTileMode } from '../../utils/types.ts';
	import { getApi } from '../../utils/helpers.ts';

	const QUEUE_KEY = 'obs-utils.applications.overlayEditor.queue';
	const DEFAULT_QUEUED_IDLE_MS = 900;

	const {
		layer,
		layerIndex,
		renameLayer,
		changeLayerType,
		commit,
	} = $props<{
		layer: OverlayData;
		layerIndex: number;
		renameLayer: (index: number, name: string) => void;
		changeLayerType: (index: number, type: string) => void;
		commit: () => void;
	}>();

	const overlayTypeOptions = $derived.by(() => {
		const types = getApi().overlayTypes;
		if (!types) return [] as Array<{ key: string; label: string }>;
		return Array.from(types.keys())
			.filter(k => k === 'sl' || k === 'wysiwyg')
			.map((k) => {
				const nameKey = getApi().overlayTypeNames?.get(k);
				return { key: k, label: nameKey ? game.i18n.localize(nameKey) : k };
			});
	});

	const tileByOptions: Array<{ value: OverlayTileMode; labelKey: string }> = [
		{ value: 'actors', labelKey: 'obs-utils.applications.overlayEditor.tileByActors' },
		{ value: 'players', labelKey: 'obs-utils.applications.overlayEditor.tileByPlayers' },
		{ value: 'users', labelKey: 'obs-utils.applications.overlayEditor.tileByUsers' },
		{ value: 'once', labelKey: 'obs-utils.applications.overlayEditor.tileByOnce' },
	];

	function onRename(e: Event) {
		renameLayer(layerIndex, (e.currentTarget as HTMLInputElement).value);
	}

	async function onTypeChange(e: Event) {
		const newType = (e.currentTarget as HTMLSelectElement).value;
		if (newType === layer.type) return;
		const hasComponents = (layer.components?.length ?? 0) > 0;
		if (hasComponents) {
			const proceed = await foundry.applications.api.DialogV2.confirm({
				content: game.i18n.localize('obs-utils.applications.overlayEditor.confirmTypeChange'),
			});
			if (!proceed) {
				(e.currentTarget as HTMLSelectElement).value = layer.type;
				return;
			}
		}
		changeLayerType(layerIndex, newType);
	}

	function onTileByChange(e: Event) {
		layer.tileBy = (e.currentTarget as HTMLSelectElement).value as OverlayTileMode;
		commit();
	}

	// Only a `transition-on-end` track has a hide phase to hand over to, so only
	// those can act as the idle hold the queue shortens.
	const idleTrackOptions = $derived.by(() =>
		(layer.animation?.tracks ?? []).filter((t: OverlayTrack) => t.behavior.type === 'transition-on-end'),
	);
	const idleTrack = $derived.by(() =>
		idleTrackOptions.find((t: OverlayTrack) => t.id === layer.queue?.idleTrackId),
	);

	function onQueueToggle(e: Event) {
		const enabled = (e.currentTarget as HTMLInputElement).checked;
		layer.queue = {
			enabled,
			idleTrackId: layer.queue?.idleTrackId ?? idleTrackOptions[0]?.id ?? '',
			queueIdleMs: layer.queue?.queueIdleMs ?? DEFAULT_QUEUED_IDLE_MS,
		};
		commit();
	}

	function onQueueIdleTrack(e: Event) {
		if (!layer.queue) return;
		layer.queue.idleTrackId = (e.currentTarget as HTMLSelectElement).value;
		commit();
	}

	function onQueuedIdleMs(e: Event) {
		if (!layer.queue) return;
		const v = Number((e.currentTarget as HTMLInputElement).value);
		layer.queue.queueIdleMs = Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
		commit();
	}

	function onCanvasWidth(e: Event) {
		const v = Number((e.currentTarget as HTMLInputElement).value) || 0;
		layer.config = { ...(layer.config ?? {}), w: Math.max(1, v) };
		commit();
	}

	function onCanvasHeight(e: Event) {
		const v = Number((e.currentTarget as HTMLInputElement).value) || 0;
		layer.config = { ...(layer.config ?? {}), h: Math.max(1, v) };
		commit();
	}

</script>

<div class='settings-workspace'>
	<section class='field-row'>
		<label class='field'>
			<span class='label'>{game.i18n?.localize('obs-utils.applications.overlayEditor.layerName') ?? 'Name'}</span>
			<input
				type='text'
				value={layer.name ?? ''}
				placeholder={`#${layerIndex} ${layer.type}`}
				onchange={onRename}
			/>
		</label>
		<label class='field'>
			<span class='label'>{game.i18n?.localize('obs-utils.applications.overlayEditor.layerType') ?? 'Type'}</span>
			<select value={layer.type} onchange={onTypeChange}>
				{#each overlayTypeOptions as opt (opt.key)}
					<option value={opt.key}>{opt.label}</option>
				{/each}
			</select>
		</label>
	</section>

	<section class='field-row'>
		<label class='field'>
			<span class='label'>{game.i18n?.localize('obs-utils.applications.overlayEditor.tileByLabel') ?? 'Tile By'}</span>
			<select value={layer.tileBy ?? 'actors'} onchange={onTileByChange}>
				{#each tileByOptions as opt (opt.value)}
					<option value={opt.value}>{game.i18n?.localize(opt.labelKey) ?? opt.value}</option>
				{/each}
			</select>
		</label>
	</section>

	{#if layer.animation}
		<section class='queue-section'>
			<span class='label'>{game.i18n?.localize(`${QUEUE_KEY}.title`) ?? 'Trigger queue'}</span>
			<label class='field checkbox'>
				<input type='checkbox' checked={layer.queue?.enabled ?? false} onchange={onQueueToggle} />
				<span>{game.i18n?.localize(`${QUEUE_KEY}.enable`) ?? 'Trigger queue'}</span>
			</label>

			{#if layer.queue?.enabled}
				<div class='field-row'>
					<label class='field'>
						<span class='label'>{game.i18n?.localize(`${QUEUE_KEY}.idleTrack`) ?? 'Idle track'}</span>
						<select
							value={layer.queue.idleTrackId}
							disabled={idleTrackOptions.length === 0}
							onchange={onQueueIdleTrack}
						>
							{#each idleTrackOptions as track (track.id)}
								<option value={track.id}>{track.name}</option>
							{/each}
						</select>
					</label>
					<label class='field'>
						<span class='label'>{game.i18n?.localize(`${QUEUE_KEY}.queuedIdleMs`) ?? 'Queued idle (ms)'}</span>
						<input
							type='number'
							min='0'
							step='1'
							value={layer.queue.queueIdleMs}
							onchange={onQueuedIdleMs}
						/>
					</label>
				</div>

				{#if idleTrackOptions.length === 0}
					<p class='hint warn'>{game.i18n?.localize(`${QUEUE_KEY}.idleTrackNone`) ?? 'This layer has no track that transitions on end — the queue stays inactive.'}</p>
				{:else if !idleTrack}
					<p class='hint warn'>{game.i18n?.localize(`${QUEUE_KEY}.invalidTrack`) ?? 'The selected idle track no longer exists — the queue stays inactive.'}</p>
				{:else}
					<p class='hint'>{game.i18n?.format(`${QUEUE_KEY}.hint`, { ms: idleTrack.durationMs }) ?? ''}</p>
				{/if}
			{/if}
		</section>
	{/if}

	{#if layer.type === 'wysiwyg'}
		<section class='field-row'>
			<label class='field'>
				<span class='label'>{game.i18n?.localize('obs-utils.applications.overlayEditor.canvasWidth') ?? 'Canvas width (px)'}</span>
				<input
					type='number'
					min='1'
					step='1'
					value={layer.config?.w ?? 1920}
					onchange={onCanvasWidth}
				/>
			</label>
			<label class='field'>
				<span class='label'>{game.i18n?.localize('obs-utils.applications.overlayEditor.canvasHeight') ?? 'Canvas height (px)'}</span>
				<input
					type='number'
					min='1'
					step='1'
					value={layer.config?.h ?? 1080}
					onchange={onCanvasHeight}
				/>
			</label>
		</section>
	{/if}

</div>

<style lang='stylus'>
	.settings-workspace
		display flex
		flex-direction column
		gap 14px
		padding 18px
		overflow-y auto
		min-height 0
		flex 1 1 auto

	.queue-section
		display flex
		flex-direction column
		gap 10px

		> .label
			font-size 11px
			text-transform uppercase
			letter-spacing 0.4px
			opacity 0.7
			font-weight 500

	.field.checkbox
		flex-direction row
		align-items center
		gap 8px
		font-size 12px

		input
			width auto
			height auto

	.hint
		margin 0
		padding 8px
		font-size 11px
		opacity 0.6
		font-style italic
		background rgba(255, 255, 255, 0.02)
		border 1px dashed rgba(255, 255, 255, 0.1)
		border-radius 3px

		&.warn
			opacity 0.9
			color #ffb347
			border-color rgba(255, 179, 71, 0.4)

	.field-row
		display grid
		grid-template-columns 1fr 1fr
		gap 12px

	.field
		display flex
		flex-direction column
		gap 4px
		min-width 0

		.label
			font-size 11px
			text-transform uppercase
			letter-spacing 0.4px
			opacity 0.7
			font-weight 500

		input, select
			width 100%
			min-width 0
			height 30px
			padding 0 8px
			background rgba(0, 0, 0, 0.3)
			border 1px solid rgba(255, 255, 255, 0.12)
			border-radius 3px
			color #e4e4e4
			font-size 12px

			&:focus
				outline none
				border-color rgba(255, 144, 0, 0.5)

		select
			appearance none
			-webkit-appearance none
			padding-right 24px
			background-image url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path fill='%23bbb' d='M6 8L2 4h8z'/></svg>")
			background-repeat no-repeat
			background-position right 8px center
			cursor pointer

			option
				background #1a1a1a
				color #e4e4e4

</style>
