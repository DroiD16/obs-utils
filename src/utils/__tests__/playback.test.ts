import type { OverlayFrame, RenderContext } from '../render.ts';
import type { OverlayData } from '../types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine, validateQueueConfig } from '../playback.ts';
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

describe('playbackEngine initial frame', () => {
	it('notifies the renderer about the initial track frame on mount', () => {
		const onFramesChanged = vi.fn();
		const frames = new Map<string, OverlayFrame>();
		const engine = new PlaybackEngine(new TriggerRegistry(), frames, onFramesChanged);
		engine.mountTile(makeOverlay(), 'singleton', { key: 'singleton' });

		expect(frames.get('ov1:singleton')?.activeTrackId).toBe('hidden');
		expect(onFramesChanged).toHaveBeenCalledTimes(1);
	});

	it('does not notify again when an equivalent overlay is re-mounted', () => {
		const onFramesChanged = vi.fn();
		const engine = new PlaybackEngine(new TriggerRegistry(), new Map(), onFramesChanged);
		engine.mountTile(makeOverlay(), 'singleton', { key: 'singleton' });
		engine.mountTile(makeOverlay(), 'singleton', { key: 'singleton' });

		expect(onFramesChanged).toHaveBeenCalledTimes(1);
	});
});

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

	it('keeps playing when the store hands back an equivalent overlay object', () => {
		const h = mount(makeOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 17 });
		expect(h.frame()?.activeTrackId).toBe('show');

		// A settings write rebuilds every OverlayData; an unrelated edit elsewhere
		// must not restart this tile.
		h.engine.mountTile(makeOverlay(), 'singleton', { key: 'singleton' });

		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 17 });
	});

	it('recreates tile state when the played-back config actually changed', () => {
		const h = mount(makeOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 17 });
		expect(h.frame()?.activeTrackId).toBe('show');

		const edited = makeOverlay();
		edited.animation!.tracks.find(t => t.id === 'show')!.durationMs = 400;
		h.engine.mountTile(edited, 'singleton', { key: 'singleton' });

		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerPayload).toBeUndefined();
	});

	it('transitions every tile for a payload that names no actor or user', () => {
		const overlay = makeOverlay({ tileBy: 'players' });
		const h = mount(overlay, [userContext('u1'), userContext('u2')]);

		// e.g. `api.fireOverlayTrigger(key, {})` or a chat message with no speaker.
		h.registry.fire('core.onPlayerRoll', { total: 12 });

		for (const key of ['user:u1', 'user:u2']) {
			expect(h.frame(key)?.activeTrackId).toBe('show');
			expect(h.frame(key)?.triggerPayload).toEqual({ total: 12 });
		}
	});

	it('broadcasts a payload that names a user without an id', () => {
		// `payloadHasIdentity` counts only ids, because ids are all
		// `payloadMatchesContext` can match on — a name-only user would otherwise
		// be filtered against every tile and reach none of them.
		const overlay = makeOverlay({ tileBy: 'players' });
		const h = mount(overlay, [userContext('u1'), userContext('u2')]);

		h.registry.fire('core.onPlayerRoll', { user: { name: 'Player 2' }, total: 12 });

		for (const key of ['user:u1', 'user:u2']) {
			expect(h.frame(key)?.activeTrackId).toBe('show');
			expect(h.frame(key)?.triggerPayload).toEqual({ user: { name: 'Player 2' }, total: 12 });
		}
	});

	it('keeps the trigger key after a plain overlay returns to its initial track', () => {
		const h = mount(makeOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 17 });
		advance(200);
		advance(1000);
		advance(200); // hide ends → hidden

		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerKey).toBe('core.onPlayerRoll');
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

// ─── trigger queue ────────────────────────────────────────────────────────────

const QUEUE_CONFIG = { enabled: true, idleTrackId: 'idle', queueIdleMs: 300 };

function makeQueueOverlay(patch: Partial<OverlayData> = {}): OverlayData {
	return makeOverlay({ queue: { ...QUEUE_CONFIG }, ...patch });
}

/** Runs `count` ticks of `ms` each and returns the track visited after each. */
function runTicks(h: Harness, count: number, ms = 1, tileKey?: string): string[] {
	const seen: string[] = [];
	for (let i = 0; i < count; i++) {
		advance(ms);
		seen.push(h.frame(tileKey)?.activeTrackId ?? '');
	}
	return seen;
}

describe('playbackEngine trigger queue', () => {
	it('shows the first trigger immediately', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });

		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 1 });
	});

	it('defers a trigger fired during the show and keeps the first payload', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		advance(50);
		h.registry.fire('core.onPlayerRoll', { total: 2 });

		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 1 });
	});

	it('holds idle for the full track duration while the queue is empty', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		advance(200); // show → idle
		expect(h.frame()?.activeTrackId).toBe('idle');
		advance(999);
		expect(h.frame()?.activeTrackId).toBe('idle');
		advance(1);
		expect(h.frame()?.activeTrackId).toBe('hide');
	});

	it('shortens the idle hold to queueIdleMs once something is queued', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		advance(200); // show → idle at t=200
		advance(100);
		h.registry.fire('core.onPlayerRoll', { total: 2 });
		expect(h.frame()?.activeTrackId).toBe('idle');

		advance(150); // idle held 250ms of the 300ms budget
		expect(h.frame()?.activeTrackId).toBe('idle');
		advance(60); // 310ms
		expect(h.frame()?.activeTrackId).toBe('hide');
		expect(h.frame()?.triggerPayload).toEqual({ total: 1 });
	});

	it('hides at once when the shortened idle budget is already spent', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		advance(200); // show → idle
		advance(400); // 400ms of idle, past the 300ms queued budget

		h.registry.fire('core.onPlayerRoll', { total: 2 });

		expect(h.frame()?.activeTrackId).toBe('hide');
		expect(h.frame()?.triggerPayload).toEqual({ total: 1 });
	});

	it('never interrupts a hide in progress', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		advance(200);
		advance(1000); // idle → hide
		expect(h.frame()?.activeTrackId).toBe('hide');

		h.registry.fire('core.onPlayerRoll', { total: 2 });
		expect(h.frame()?.activeTrackId).toBe('hide');
		expect(h.frame()?.triggerPayload).toEqual({ total: 1 });

		advance(199);
		expect(h.frame()?.activeTrackId).toBe('hide');
		advance(1);
		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 2 });
	});

	it('replays three triggers strictly FIFO, one plate at a time', () => {
		const h = mount(makeQueueOverlay());
		const payloads = [
			{ actor: { name: 'A' }, total: 1, formula: '1d20', flavor: 'first' },
			{ actor: { name: 'B' }, total: 2, formula: '2d6', flavor: 'second' },
			{ actor: { name: 'C' }, total: 3, formula: '1d4', flavor: 'third' },
		];
		for (const p of payloads) h.registry.fire('core.onPlayerRoll', p);

		const order: unknown[] = [];
		for (let i = 0; i < 4000; i++) {
			advance(1);
			const shown = h.frame()?.triggerPayload;
			if (shown && order[order.length - 1] !== shown) order.push(shown);
		}

		expect(order).toEqual(payloads);
		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerPayload).toBeUndefined();
	});

	it('caps the queued idle at the track duration', () => {
		const h = mount(makeQueueOverlay({ queue: { enabled: true, idleTrackId: 'idle', queueIdleMs: 5000 } }));
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		advance(200);
		h.registry.fire('core.onPlayerRoll', { total: 2 });

		advance(999);
		expect(h.frame()?.activeTrackId).toBe('idle');
		advance(1);
		expect(h.frame()?.activeTrackId).toBe('hide');
	});

	it('does not stall or spin with zero-length tracks and a zero queued idle', () => {
		const overlay = makeQueueOverlay({ queue: { enabled: true, idleTrackId: 'idle', queueIdleMs: 0 } });
		for (const track of overlay.animation!.tracks) {
			if (track.id !== 'hidden') track.durationMs = 0;
		}
		const h = mount(overlay);
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		h.registry.fire('core.onPlayerRoll', { total: 2 });

		const visited = runTicks(h, 12);

		expect(visited).toContain('hide');
		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerPayload).toBeUndefined();
	});

	it('falls back to un-queued behaviour when the config is off or invalid', () => {
		for (const queue of [
			{ enabled: false, idleTrackId: 'idle', queueIdleMs: 300 },
			{ enabled: true, idleTrackId: 'nope', queueIdleMs: 300 },
			{ enabled: true, idleTrackId: 'hidden', queueIdleMs: 300 }, // static, not transition-on-end
		]) {
			const h = mount(makeQueueOverlay({ queue }));
			h.registry.fire('core.onPlayerRoll', { total: 1 });
			advance(200); // show → idle

			// A second roll while the first is up. There is no transition out of
			// `idle` for this key, and without a live queue nothing holds it, so it
			// is dropped: the plate keeps showing the first roll.
			h.registry.fire('core.onPlayerRoll', { total: 2 });
			expect(h.frame()?.activeTrackId).toBe('idle');
			expect(h.frame()?.triggerPayload).toEqual({ total: 1 });

			// The idle hold keeps the full track duration — a live queue would have
			// cut it down to queueIdleMs (300ms).
			advance(799);
			expect(h.frame()?.activeTrackId).toBe('idle');
			advance(200);
			expect(h.frame()?.activeTrackId).toBe('idle');
			advance(1);
			expect(h.frame()?.activeTrackId).toBe('hide');

			// Back on the initial track, and the dropped roll is never replayed.
			// Outside the queue the finished snapshot is deliberately kept (stage-1
			// semantics), so it is still the first roll's — never the second's.
			advance(200);
			expect(h.frame()?.activeTrackId).toBe('hidden');
			expect(h.frame()?.triggerPayload).toEqual({ total: 1 });
			expect(runTicks(h, 5, 200)).toEqual(Array.from({ length: 5 }).fill('hidden'));
			expect(h.frame()?.triggerPayload).toEqual({ total: 1 });
		}
	});

	it('queues per tile — a roll only lands in its own player queue', () => {
		const overlay = makeQueueOverlay({ tileBy: 'players' });
		const h = mount(overlay, [userContext('u1'), userContext('u2')]);

		h.registry.fire('core.onPlayerRoll', { user: { id: 'u1' }, total: 1 });
		h.registry.fire('core.onPlayerRoll', { user: { id: 'u1' }, total: 2 });
		h.registry.fire('core.onPlayerRoll', { user: { id: 'u2' }, total: 9 });

		expect(h.frame('user:u1')?.triggerPayload).toEqual({ user: { id: 'u1' }, total: 1 });
		expect(h.frame('user:u2')?.triggerPayload).toEqual({ user: { id: 'u2' }, total: 9 });

		advance(200);
		advance(1000);
		advance(200); // u1: hide done → queued roll released, u2 has nothing queued
		expect(h.frame('user:u1')?.triggerPayload).toEqual({ user: { id: 'u1' }, total: 2 });
		expect(h.frame('user:u2')?.activeTrackId).toBe('hidden');
		expect(h.frame('user:u2')?.triggerPayload).toBeUndefined();
	});

	it('drops the queue when the tile is unmounted and remounted', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		h.registry.fire('core.onPlayerRoll', { total: 2 }); // queued behind the first

		h.engine.unmountTile('ov1', 'singleton');
		expect(h.frame()).toBeUndefined();

		h.engine.mountTile(makeQueueOverlay(), 'singleton', { key: 'singleton' });
		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerPayload).toBeUndefined();

		// The queue died with the old state: the next roll shows at once instead
		// of waiting behind the two that were in flight.
		h.registry.fire('core.onPlayerRoll', { total: 3 });
		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 3 });
	});

	it('drops the queue when the overlay config changes under the tile', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		h.registry.fire('core.onPlayerRoll', { total: 2 });

		h.engine.mountTile(makeQueueOverlay({ queue: { ...QUEUE_CONFIG, queueIdleMs: 500 } }), 'singleton', { key: 'singleton' });
		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerPayload).toBeUndefined();

		runTicks(h, 5, 500);
		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerPayload).toBeUndefined();
	});

	it('keeps the queue when the store hands back an equivalent overlay object', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		h.registry.fire('core.onPlayerRoll', { total: 2 });

		h.engine.mountTile(makeQueueOverlay(), 'singleton', { key: 'singleton' });
		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 1 });

		advance(200); // show → idle
		advance(300); // shortened idle → hide
		advance(200); // hide → hidden, queued roll released
		expect(h.frame()?.triggerPayload).toEqual({ total: 2 });
	});

	it('measures the idle hold from the playhead when the show hands over mid-track', () => {
		const overlay = makeQueueOverlay();
		// Show ends 400ms into the idle track, so only 600ms of idle are left.
		overlay.animation!.tracks.find(t => t.id === 'show')!.behavior = {
			type: 'transition-on-end',
			toTrackId: 'idle',
			toTime: 400,
		};
		const h = mount(overlay);
		h.registry.fire('core.onPlayerRoll', { total: 1 });

		advance(200); // show → idle, playhead already at 400
		expect(h.frame()?.activeTrackId).toBe('idle');
		advance(599);
		expect(h.frame()?.activeTrackId).toBe('idle');
		advance(2);
		expect(h.frame()?.activeTrackId).toBe('hide');
	});

	it('falls open when the idle track never hands back to the initial track', () => {
		for (const patchHide of [
			(o: OverlayData) => {
				o.animation!.tracks.find(t => t.id === 'hide')!.behavior = { type: 'static' };
			},
			(o: OverlayData) => {
				o.animation!.tracks.find(t => t.id === 'hide')!.behavior = {
					type: 'transition-on-end',
					toTrackId: 'gone',
					toTime: 0,
				};
			},
		]) {
			const overlay = makeQueueOverlay();
			patchHide(overlay);
			const h = mount(overlay);
			h.registry.fire('core.onPlayerRoll', { total: 1 });
			advance(200); // show → idle
			h.registry.fire('core.onPlayerRoll', { total: 2 });

			// With a live queue this would hide after queueIdleMs (300ms).
			advance(999);
			expect(h.frame()?.activeTrackId).toBe('idle');
			advance(1);
			expect(h.frame()?.activeTrackId).toBe('hide');
		}
	});

	it('drains the queue when the idle track is also the initial track', () => {
		// Degenerate but legal config: the tile rests on the idle track itself,
		// so `hide` hands straight back to it. Entering it must still release the
		// next queued trigger — there is no other track that could.
		const overlay = makeQueueOverlay();
		const animation = overlay.animation!;
		animation.initialTrackId = 'idle';
		animation.tracks.find(t => t.id === 'hide')!.behavior = {
			type: 'transition-on-end',
			toTrackId: 'idle',
			toTime: 0,
		};
		animation.transitions[0].fromTrackId = 'idle';
		const h = mount(overlay);

		h.registry.fire('core.onPlayerRoll', { total: 1 });
		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 1 });

		// Two more rolls while the plate is busy: both are held, neither shown.
		advance(50);
		h.registry.fire('core.onPlayerRoll', { total: 2 });
		advance(50);
		h.registry.fire('core.onPlayerRoll', { total: 3 });
		expect(h.frame()?.triggerPayload).toEqual({ total: 1 });

		// The show hands over to idle — which is the initial track, so the head of
		// the queue is released at once rather than waiting out an idle hold.
		advance(100);
		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 2 });

		// Strictly FIFO: the third roll never overtook the second.
		advance(200);
		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: 3 });

		// Queue drained: the tile settles back on the initial track with no payload.
		advance(200);
		expect(h.frame()?.activeTrackId).toBe('idle');
		expect(h.frame()?.triggerPayload).toBeUndefined();
		expect(h.frame()?.triggerKey).toBeUndefined();
	});

	it('releases a long queue of self-returning triggers without recursing', () => {
		// A trigger whose destination is the initial track itself: releasing it
		// puts the tile straight back where the next release happens. Draining
		// such a queue recursively costs one stack frame per entry.
		const overlay = makeQueueOverlay();
		overlay.animation!.transitions.push({
			triggerKey: 'core.selfLoop',
			fromTrackId: 'hidden',
			zones: [{ startT: 0, endT: 1, destination: { type: 'goto', toTrackId: 'hidden', toTime: 0 } }],
		});
		const h = mount(overlay);

		h.registry.fire('core.onPlayerRoll', { total: 0 }); // occupies the tile
		const count = 5000;
		for (let i = 1; i <= count; i++) h.registry.fire('core.selfLoop', { total: i });
		h.registry.fire('core.onPlayerRoll', { total: count + 1 });

		advance(200); // show → idle
		advance(300); // shortened idle → hide
		advance(200); // hide ends → the whole queue drains here

		// FIFO held: every self-returning entry was consumed, in order, before the
		// trailing roll — which is the one left on screen.
		expect(h.frame()?.activeTrackId).toBe('show');
		expect(h.frame()?.triggerPayload).toEqual({ total: count + 1 });
	});

	it('forgets the finished trigger once the tile is idle again', () => {
		const h = mount(makeQueueOverlay());
		h.registry.fire('core.onPlayerRoll', { total: 1 });
		advance(200);
		advance(1000);
		advance(200); // hide ends → hidden, queue empty

		expect(h.frame()?.activeTrackId).toBe('hidden');
		expect(h.frame()?.triggerPayload).toBeUndefined();
		expect(h.frame()?.triggerKey).toBeUndefined();
	});
});

// ─── queue config validation ──────────────────────────────────────────────────

describe('validateQueueConfig', () => {
	it('accepts the show → idle → hide → initial chain', () => {
		expect(validateQueueConfig(makeQueueOverlay())).toBe('ok');
	});

	it('reports a queue that is absent or switched off', () => {
		expect(validateQueueConfig(makeOverlay())).toBe('disabled');
		expect(validateQueueConfig(makeQueueOverlay({
			queue: { enabled: false, idleTrackId: 'idle', queueIdleMs: 300 },
		}))).toBe('disabled');
	});

	it('reports a layer with no track that transitions on end', () => {
		const overlay = makeQueueOverlay();
		for (const track of overlay.animation!.tracks) track.behavior = { type: 'static' };
		expect(validateQueueConfig(overlay)).toBe('no-idle-track');
	});

	it('reports an idle track that is gone or no longer transitions on end', () => {
		expect(validateQueueConfig(makeQueueOverlay({
			queue: { enabled: true, idleTrackId: 'nope', queueIdleMs: 300 },
		}))).toBe('invalid-idle-track');
		expect(validateQueueConfig(makeQueueOverlay({
			queue: { enabled: true, idleTrackId: 'hidden', queueIdleMs: 300 },
		}))).toBe('invalid-idle-track');
	});

	it('reports a chain that never hands back to the initial track', () => {
		const overlay = makeQueueOverlay();
		overlay.animation!.tracks.find(t => t.id === 'hide')!.behavior = {
			type: 'transition-on-end',
			toTrackId: 'gone',
			toTime: 0,
		};
		expect(validateQueueConfig(overlay)).toBe('chain-does-not-return');
	});
});
