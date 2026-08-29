import type { OverlayFrame, RenderContext } from '../render.ts';
import type { OverlayData } from '../types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from '../playback.ts';
import { TriggerRegistry } from '../triggers.ts';

// ─── clock + rAF harness ──────────────────────────────────────────────────────
// The engine reads wall time from `performance.now()` and drives itself from
// rAF. Both are stubbed so tests step time explicitly.

let now = 0;
let rafCallback: ((t: number) => void) | null = null;

beforeEach(() => {
	now = 0;
	rafCallback = null;
	vi.stubGlobal('performance', { now: () => now });
	vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
		rafCallback = cb;
		return 1;
	});
	vi.stubGlobal('cancelAnimationFrame', () => {
		rafCallback = null;
	});
	// The registry re-broadcasts public triggers through Foundry's hook bus.
	vi.stubGlobal('Hooks', { on: vi.fn(), off: vi.fn(), callAll: vi.fn() });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Move the clock forward and run exactly one engine tick. */
function advance(ms: number): void {
	now += ms;
	const cb = rafCallback;
	rafCallback = null;
	cb?.(now);
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

function opacityLane(v: number) {
	return { componentId: 'c1', keyframes: [], propertyKeyframes: { opacity: [{ t: 0, v }] } };
}

/**
 * hidden (static, initial) →[core.onPlayerRoll]→ show (200ms) → idle (1000ms)
 * → hide (200ms) → hidden.
 */
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
			tracks: [
				{ id: 'hidden', name: 'Hidden', durationMs: 0, behavior: { type: 'static' }, lanes: [opacityLane(0)] },
				{ id: 'show', name: 'Show', durationMs: 200, behavior: { type: 'transition-on-end', toTrackId: 'idle', toTime: 0 }, lanes: [opacityLane(1)] },
				{ id: 'idle', name: 'Idle', durationMs: 1000, behavior: { type: 'transition-on-end', toTrackId: 'hide', toTime: 0 }, lanes: [opacityLane(1)] },
				{ id: 'hide', name: 'Hide', durationMs: 200, behavior: { type: 'transition-on-end', toTrackId: 'hidden', toTime: 0 }, lanes: [opacityLane(0)] },
			],
			transitions: [{
				triggerKey: 'core.onPlayerRoll',
				fromTrackId: 'hidden',
				zones: [{ startT: 0, endT: 1, destination: { type: 'goto', toTrackId: 'show', toTime: 0 } }],
			}],
		},
		...patch,
	} as OverlayData;
}

interface Harness {
	engine: PlaybackEngine;
	registry: TriggerRegistry;
	frames: Map<string, OverlayFrame>;
	frame: (tileKey?: string) => OverlayFrame | undefined;
}

function mount(overlay: OverlayData, contexts: RenderContext[] = [{ key: 'singleton' }]): Harness {
	const registry = new TriggerRegistry();
	const frames = new Map<string, OverlayFrame>();
	const engine = new PlaybackEngine(registry, frames, () => {});
	for (const ctx of contexts) engine.mountTile(overlay, ctx.key, ctx);
	engine.start();
	return {
		engine,
		registry,
		frames,
		frame: (tileKey = contexts[0].key) => frames.get(`${overlay.id}:${tileKey}`),
	};
}

function userContext(id: string): RenderContext {
	return { key: `user:${id}`, user: { id, name: id } };
}

// ─── snapshot payload ─────────────────────────────────────────────────────────

describe('playbackEngine trigger payload snapshot', () => {
	it('pins the firing payload onto the tile frame', () => {
		const h = mount(makeOverlay());
		expect(h.frame()?.triggerPayload).toBeUndefined();

		h.registry.fire('core.onPlayerRoll', { total: 17, actor: { name: 'Hero' } });

		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 17, actor: { name: 'Hero' } });
	});

	it('keeps the snapshot while a later payload for the same key arrives mid-show', () => {
		const h = mount(makeOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 17 });
		advance(50);
		// `hidden` is no longer the current track, so B cannot transition anything.
		h.registry.fire('core.onPlayerRoll', { total: 3 });

		expect(h.frame()?.triggerPayload).toEqual({ total: 17 });
	});

	it('does not transition or snapshot a tile the payload does not belong to', () => {
		const overlay = makeOverlay({ tileBy: 'players' });
		const h = mount(overlay, [userContext('u1'), userContext('u2')]);

		h.registry.fire('core.onPlayerRoll', { user: { id: 'u1' }, total: 12 });

		expect(h.frame('user:u1')?.activeTrackId).toBe('show');
		expect(h.frame('user:u1')?.triggerPayload).toEqual({ user: { id: 'u1' }, total: 12 });
		expect(h.frame('user:u2')?.activeTrackId).toBe('hidden');
		expect(h.frame('user:u2')?.triggerPayload).toBeUndefined();
	});

	it('survives the return to the initial track without the queue', () => {
		const h = mount(makeOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 17 });
		advance(200); // show ends → idle
		advance(1000); // idle ends → hide
		advance(200); // hide ends → hidden

		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerPayload).toEqual({ total: 17 });
	});

	it('recreates tile state when mountTile is given a different overlay object', () => {
		const overlay = makeOverlay();
		const h = mount(overlay);
		h.registry.fire('core.onPlayerRoll', { total: 17 });
		expect(h.frame()?.activeTrackId).toBe('show');

		h.engine.mountTile(makeOverlay(), 'singleton', { key: 'singleton' });

		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerPayload).toBeUndefined();
	});

	it('drops the tile state on unmount', () => {
		const overlay = makeOverlay();
		const h = mount(overlay);
		h.registry.fire('core.onPlayerRoll', { total: 17 });
		h.engine.unmountTile('ov1', 'singleton');

		expect(h.frame()).toBeUndefined();
		h.registry.fire('core.onPlayerRoll', { total: 5 });
		expect(h.frame()).toBeUndefined();
	});
});
