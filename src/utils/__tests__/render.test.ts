import type { OverlayFrame, RenderState } from '../render.ts';
import type { OverlayData } from '../types.ts';
import { describe, expect, it } from 'vitest';
import { buildRenderTree, buildTileContext, payloadMatchesContext } from '../render.ts';

function makeOverlay(patch: Partial<OverlayData> = {}): OverlayData {
	return {
		id: 'ov1',
		type: 'sl',
		style: '',
		config: {},
		tileBy: 'once',
		components: [{ id: 'c1', type: 'pt', data: 'trigger.total', style: '' }],
		animation: {
			initialTrackId: 'hidden',
			tracks: [{ id: 'hidden', name: 'Hidden', durationMs: 0, behavior: { type: 'static' }, lanes: [] }],
			transitions: [{ triggerKey: 'core.onPlayerRoll', fromTrackId: 'hidden', zones: [] }],
		},
		...patch,
	} as OverlayData;
}

function makeState(patch: Partial<RenderState> = {}): RenderState {
	return {
		actors: new Map(),
		users: new Map(),
		triggerPayloads: new Map(),
		...patch,
	};
}

function frame(patch: Partial<OverlayFrame> = {}): OverlayFrame {
	return { activeTrackId: 'hidden', playheadT: 0, components: new Map(), ...patch };
}

function textOf(overlay: OverlayData, state: RenderState): string {
	const tree = buildRenderTree([overlay], state);
	return String(tree.overlays[0].components[0].values.value);
}

describe('resolveTriggerPayload', () => {
	it('prefers the frame snapshot over the latest global payload', () => {
		const overlay = makeOverlay();
		const state = makeState({
			triggerPayloads: new Map([['core.onPlayerRoll', { total: 3 }]]),
			frames: new Map([['ov1:singleton', frame({ triggerKey: 'core.onPlayerRoll', triggerPayload: { total: 17 } })]]),
		});

		expect(textOf(overlay, state)).toBe('17');
	});

	it('falls back to the global payload when the frame has no snapshot', () => {
		const overlay = makeOverlay();
		const state = makeState({
			triggerPayloads: new Map([['core.onPlayerRoll', { total: 3 }]]),
			frames: new Map([['ov1:singleton', frame({ triggerKey: 'core.onPlayerRoll' })]]),
		});

		expect(textOf(overlay, state)).toBe('3');
	});

	it('falls back to the global payload when there is no frame at all', () => {
		const overlay = makeOverlay();
		const state = makeState({ triggerPayloads: new Map([['core.onPlayerRoll', { total: 3 }]]) });

		expect(textOf(overlay, state)).toBe('3');
	});
});

describe('payloadMatchesContext', () => {
	const ctxUser = { key: 'user:u1', user: { id: 'u1' } };
	const ctxActor = { key: 'actor:a1', actor: { id: 'a1' } };

	it('rejects a missing payload', () => {
		expect(payloadMatchesContext(makeOverlay(), ctxUser, undefined)).toBe(false);
	});

	it('accepts anything in preview mode', () => {
		expect(payloadMatchesContext(makeOverlay({ tileBy: 'players' }), ctxUser, { user: { id: 'other' } }, true)).toBe(true);
	});

	it('accepts anything for a singleton tile', () => {
		expect(payloadMatchesContext(makeOverlay(), { key: 'singleton' }, { total: 1 })).toBe(true);
	});

	it('matches player tiles on payload.user.id', () => {
		const overlay = makeOverlay({ tileBy: 'players' });
		expect(payloadMatchesContext(overlay, ctxUser, { user: { id: 'u1' } })).toBe(true);
		expect(payloadMatchesContext(overlay, ctxUser, { user: { id: 'u2' } })).toBe(false);
	});

	it('matches actor tiles on payload.actor.id or the message speaker', () => {
		const overlay = makeOverlay({ tileBy: 'actors' });
		expect(payloadMatchesContext(overlay, ctxActor, { actor: { id: 'a1' } })).toBe(true);
		expect(payloadMatchesContext(overlay, ctxActor, { message: { speaker: { actor: 'a1' } } })).toBe(true);
		expect(payloadMatchesContext(overlay, ctxActor, { actor: { id: 'a2' } })).toBe(false);
	});
});

describe('buildTileContext', () => {
	it('builds a singleton context', () => {
		expect(buildTileContext('once', 'singleton', makeState())).toEqual({ key: 'singleton' });
	});

	it('builds a user context including the assigned character', () => {
		const state = makeState({ users: new Map([['u1', { name: 'Player2', character: { id: 'a1', name: 'Hero' } }]]) });
		expect(buildTileContext('players', 'u1', state)).toEqual({
			key: 'user:u1',
			user: { id: 'u1', name: 'Player2' },
			actor: { id: 'a1', name: 'Hero' },
		});
	});

	it('builds an actor context', () => {
		const state = makeState({ actors: new Map([['a1', { name: 'Hero' }]]) });
		expect(buildTileContext('actors', 'a1', state)).toEqual({ key: 'actor:a1', actor: { id: 'a1', name: 'Hero' } });
	});
});
