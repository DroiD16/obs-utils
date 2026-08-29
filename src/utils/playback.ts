import type { OverlayTrack, TrackTransition, TransitionZone, ZoneDestination } from './overlayAnimation.ts';
import type { ComponentFrame, OverlayFrame, RenderContext } from './render.ts';
import type { TriggerRegistry } from './triggers.ts';
import type { OverlayData } from './types.ts';
import { computeTrackFrame, findActiveZone } from './overlayAnimation.ts';
import { payloadHasIdentity, payloadMatchesContext } from './render.ts';

interface QueuedTrigger {
	triggerKey: string;
	payload: Record<string, unknown>;
	/** The `goto` this trigger would have taken out of the initial track. */
	destination: ZoneDestination;
}

interface TileState {
	overlay: OverlayData;
	tileKey: string;
	/** Needed to decide whether an incoming trigger payload belongs to this tile. */
	context: RenderContext;
	currentTrackId: string;
	startWall: number;
	lastTriggerKey?: string;
	/** Payload of the trigger that started the current show. */
	activePayload?: Record<string, unknown>;
	/** Triggers deferred while the tile was busy, replayed FIFO. */
	queue: QueuedTrigger[];
}

function stateKey(overlayId: string, tileKey: string): string {
	return `${overlayId}:${tileKey}`;
}

export class PlaybackEngine {
	private readonly states = new Map<string, TileState>();
	private readonly frames: Map<string, OverlayFrame>;
	private readonly registry: TriggerRegistry;
	private readonly onFramesChanged: () => void;
	private readonly previewMode: () => boolean;
	private readonly perTriggerUnsubs: Array<() => void> = [];

	private rafId: number | null = null;
	private running = false;

	constructor(
		registry: TriggerRegistry,
		frames: Map<string, OverlayFrame>,
		onFramesChanged: () => void,
		previewMode: () => boolean = () => false,
	) {
		this.registry = registry;
		this.frames = frames;
		this.onFramesChanged = onFramesChanged;
		this.previewMode = previewMode;
	}

	mountTile(overlay: OverlayData, tileKey: string, context: RenderContext): void {
		if (!overlay.animation) return;
		const key = stateKey(overlay.id ?? '', tileKey);
		const existing = this.states.get(key);
		// The settings store rebuilds every `OverlayData` on any settings write,
		// so object identity would restart each tile (and drop its queue) on an
		// unrelated slider edit. Only a change to the parts the engine actually
		// plays back — animation, queue, tiling — restarts the tile.
		if (existing) {
			if (playbackSignature(existing.overlay) === playbackSignature(overlay)) {
				existing.overlay = overlay;
				existing.context = context;
				return;
			}
			this.states.delete(key);
		}
		const state: TileState = {
			overlay,
			tileKey,
			context,
			currentTrackId: overlay.animation.initialTrackId,
			startWall: performance.now(),
			queue: [],
		};
		this.states.set(key, state);
		this.subscribeTransitions(overlay);
		this.computeFrame(state);
	}

	unmountTile(overlayId: string, tileKey: string): void {
		const key = stateKey(overlayId, tileKey);
		this.states.delete(key);
		this.frames.delete(key);
	}

	start(): void {
		if (this.running) return;
		for (const state of this.states.values()) this.subscribeTransitions(state.overlay);
		this.running = true;
		this.scheduleTick();
	}

	stop(): void {
		this.running = false;
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		for (const unsub of this.perTriggerUnsubs) unsub();
		this.perTriggerUnsubs.length = 0;
		this.subscribedTriggers.clear();
	}

	private readonly subscribedTriggers = new Set<string>();

	private subscribeTransitions(overlay: OverlayData): void {
		const transitions = overlay.animation?.transitions ?? [];
		for (const tr of transitions) {
			if (this.subscribedTriggers.has(tr.triggerKey)) continue;
			this.subscribedTriggers.add(tr.triggerKey);
			try {
				this.registry.register({ key: tr.triggerKey });
			} catch { /* already registered */ }
			const unsub = this.registry.subscribe<Record<string, unknown>>(
				tr.triggerKey,
				payload => this.handleTriggerFire(tr.triggerKey, payload),
			);
			this.perTriggerUnsubs.push(unsub);
		}
	}

	private handleTriggerFire(key: string, payload?: Record<string, unknown>): void {
		const now = performance.now();
		for (const state of this.states.values()) {
			// A payload naming no actor and no user addresses every tile; only an
			// identity-bearing payload is filtered down to the tile it belongs to.
			const addressed = !payloadHasIdentity(payload)
				|| payloadMatchesContext(state.overlay, state.context, payload, this.previewMode());
			if (!addressed) continue;
			const handled = this.applyMatchingTransitions(state, key, payload, now);
			// Nothing to transition from the current track and the tile is mid-show:
			// hold the trigger and replay it once the tile is free again.
			if (!handled && isQueueActive(state) && isSlotBusy(state)) {
				this.enqueueTrigger(state, key, payload ?? {}, now);
			}
		}
		this.onFramesChanged();
	}

	/** Applies every transition leaving the current track. Returns whether any matched. */
	private applyMatchingTransitions(
		state: TileState,
		key: string,
		payload: Record<string, unknown> | undefined,
		now: number,
	): boolean {
		const track = this.getTrack(state);
		// Static tracks have no advancing playhead — pin to 0 so [0, x) zones match.
		const playheadT = track?.behavior.type === 'static'
			? 0
			: Math.max(0, now - state.startWall);
		let handled = false;
		const transitions = state.overlay.animation?.transitions ?? [];
		for (const tr of transitions) {
			if (tr.triggerKey !== key) continue;
			if (tr.fromTrackId !== state.currentTrackId) continue;
			const zone = this.resolveZone(tr, playheadT, track);
			if (!zone) continue;
			// Deliberate: an `ignore` zone counts as handled, so a trigger the
			// author muted on this track is swallowed rather than queued.
			handled = true;
			state.lastTriggerKey = key;
			if (zone.destination.type !== 'ignore') state.activePayload = payload;
			this.applyDestination(state, zone.destination, now);
		}
		return handled;
	}

	private resolveZone(tr: TrackTransition, playheadT: number, track: OverlayTrack | undefined): TransitionZone | undefined {
		const zone = findActiveZone(tr, playheadT);
		// Static tracks: fall back to first zone when explicit matching fails.
		if (!zone && track?.behavior.type === 'static') return tr.zones[0];
		return zone;
	}

	/**
	 * Queues the transition this trigger would have taken out of the initial
	 * track. Anything else (no such transition, or an `ignore` zone) is dropped.
	 */
	private enqueueTrigger(state: TileState, key: string, payload: Record<string, unknown>, now: number): void {
		const animation = state.overlay.animation;
		if (!animation) return;
		const initialTrack = animation.tracks.find(t => t.id === animation.initialTrackId);
		for (const tr of animation.transitions) {
			if (tr.triggerKey !== key) continue;
			if (tr.fromTrackId !== animation.initialTrackId) continue;
			const zone = this.resolveZone(tr, 0, initialTrack);
			if (zone?.destination.type !== 'goto') continue;
			state.queue.push({ triggerKey: key, payload, destination: zone.destination });
			// A queued trigger shortens the idle hold, which may already be over.
			if (state.currentTrackId === state.overlay.queue?.idleTrackId && now - state.startWall >= idleDeadlineMs(state)) {
				this.enterHide(state, now);
			}
			return;
		}
	}

	/** Leaves the idle track early, taking its `transition-on-end` destination. */
	private enterHide(state: TileState, now: number): void {
		const idle = idleTrack(state);
		if (idle?.behavior.type !== 'transition-on-end') return;
		this.gotoTrack(state, idle.behavior.toTrackId, idle.behavior.toTime, now);
		this.computeFrame(state);
	}

	/**
	 * Bookkeeping for every track change: once the tile is back on the initial
	 * track it forgets the finished trigger and releases the next queued one.
	 */
	private onTrackEntered(state: TileState, now: number): void {
		if (!isQueueActive(state)) return;
		// The initial track is the only place a queued trigger can be released
		// from, including the degenerate config where it doubles as the idle
		// track — there entering it frees the slot, so the head goes out at once.
		if (state.currentTrackId !== state.overlay.animation?.initialTrackId) return;
		state.activePayload = undefined;
		// The show is over — nothing about the finished trigger should linger.
		state.lastTriggerKey = undefined;
		const next = state.queue.shift();
		if (!next) return;
		state.activePayload = next.payload;
		state.lastTriggerKey = next.triggerKey;
		this.applyDestination(state, next.destination, now);
	}

	private applyDestination(state: TileState, dest: ZoneDestination, now: number): void {
		if (dest.type === 'ignore') return;
		this.gotoTrack(state, dest.toTrackId, dest.toTime, now);
		this.computeFrame(state);
	}

	private gotoTrack(state: TileState, toTrackId: string, toTime: number, now: number): void {
		state.currentTrackId = toTrackId;
		state.startWall = now - toTime;
		this.onTrackEntered(state, now);
	}

	private scheduleTick(): void {
		if (!this.running) return;
		this.rafId = requestAnimationFrame(now => this.tick(now));
	}

	private tick(now: number): void {
		let changed = false;
		for (const state of this.states.values()) {
			const before = this.frames.get(stateKey(state.overlay.id ?? '', state.tileKey));
			this.advanceTrack(state, now);
			const after = this.computeFrame(state);
			if (!framesEqual(before, after)) changed = true;
		}
		if (changed) this.onFramesChanged();
		this.scheduleTick();
	}

	private advanceTrack(state: TileState, now: number): void {
		const track = this.getTrack(state);
		if (!track) return;
		if (track.behavior.type === 'static') return;
		if (track.behavior.type === 'looping') {
			if (track.durationMs <= 0) return;
			const playheadT = now - state.startWall;
			if (playheadT < track.durationMs) return;
			state.startWall = now - (playheadT % track.durationMs);
			return;
		}
		// A zero-length `transition-on-end` track hands over immediately instead of
		// stalling. At most one hand-over per tick, so a zero-length cycle cannot spin.
		const isIdle = isQueueActive(state) && track.id === state.overlay.queue?.idleTrackId;
		const elapsed = now - state.startWall;
		const deadline = isIdle ? idleDeadlineMs(state) : track.durationMs;
		if (elapsed < deadline) return;
		this.gotoTrack(state, track.behavior.toTrackId, track.behavior.toTime, now);
	}

	private computeFrame(state: TileState): OverlayFrame | undefined {
		const track = this.getTrack(state);
		if (!track) return undefined;
		const playheadT = track.behavior.type === 'static'
			? 0
			: Math.max(0, performance.now() - state.startWall);
		const componentFrames = new Map<string, ComponentFrame>();
		for (const [componentId, kf] of computeTrackFrame(track, playheadT)) {
			componentFrames.set(componentId, kf);
		}
		const frame: OverlayFrame = {
			activeTrackId: state.currentTrackId,
			playheadT,
			components: componentFrames,
			triggerKey: state.lastTriggerKey,
			triggerPayload: state.activePayload,
		};
		this.frames.set(stateKey(state.overlay.id ?? '', state.tileKey), frame);
		return frame;
	}

	private getTrack(state: TileState): OverlayTrack | undefined {
		return state.overlay.animation?.tracks.find(t => t.id === state.currentTrackId);
	}
}

/** The track named by the queue config, if the overlay has one. */
function idleTrack(state: TileState): OverlayTrack | undefined {
	const id = state.overlay.queue?.idleTrackId;
	if (!id) return undefined;
	return state.overlay.animation?.tracks.find(t => t.id === id);
}

/**
 * A queue only runs against a well-formed config. Anything else falls open —
 * the tile behaves exactly as it would without a queue.
 */
function isQueueActive(state: TileState): boolean {
	if (!state.overlay.queue?.enabled) return false;
	const idle = idleTrack(state);
	if (idle?.behavior.type !== 'transition-on-end') return false;
	return leadsBackToInitialTrack(state, idle);
}

/**
 * The hide phase is whatever the idle track hands over to — it only counts as a
 * queue if that chain ends back on the initial track, where the next queued
 * trigger can be released. The walk is bounded by the number of tracks.
 */
function leadsBackToInitialTrack(state: TileState, idle: OverlayTrack): boolean {
	const animation = state.overlay.animation;
	if (!animation) return false;
	let track: OverlayTrack | undefined = idle;
	for (let hops = 0; hops < animation.tracks.length; hops++) {
		if (track?.behavior.type !== 'transition-on-end') return false;
		const nextId: string = track.behavior.toTrackId;
		if (nextId === animation.initialTrackId) return true;
		track = animation.tracks.find(t => t.id === nextId);
		if (!track) return false;
	}
	return false;
}

/**
 * Identifies the parts of an overlay the engine plays back. Cached per object:
 * `mountTile` runs for every tile on every frame, so this must not re-serialize
 * the animation each time. An object mutated in place keeps its cached
 * signature — exactly the behaviour of the object-identity check it replaces.
 * The Composer preview edits its overlay in place on the same client, so config
 * changes do not restart the preview tile; only a settings round-trip, which
 * rebuilds every `OverlayData`, produces a fresh object and remounts it.
 */
const signatureCache = new WeakMap<OverlayData, string>();

function playbackSignature(overlay: OverlayData): string {
	const cached = signatureCache.get(overlay);
	if (cached !== undefined) return cached;
	const signature = JSON.stringify({
		tileBy: overlay.tileBy ?? null,
		queue: overlay.queue ?? null,
		animation: overlay.animation ?? null,
	});
	signatureCache.set(overlay, signature);
	return signature;
}

function isSlotBusy(state: TileState): boolean {
	return state.currentTrackId !== state.overlay.animation?.initialTrackId;
}

/** A pending trigger shortens the idle hold; it never lengthens it. */
function idleDeadlineMs(state: TileState): number {
	const track = idleTrack(state);
	if (!track) return Number.POSITIVE_INFINITY;
	if (state.queue.length === 0) return track.durationMs;
	return Math.min(track.durationMs, state.overlay.queue?.queueIdleMs ?? track.durationMs);
}

function framesEqual(a: OverlayFrame | undefined, b: OverlayFrame | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.activeTrackId !== b.activeTrackId) return false;
	if (a.playheadT !== b.playheadT) return false;
	if (a.triggerPayload !== b.triggerPayload) return false;
	if (a.components.size !== b.components.size) return false;
	for (const [id, frameA] of a.components) {
		const frameB = b.components.get(id);
		if (!frameB) return false;
		if (frameA.opacity !== frameB.opacity) return false;
		if (frameA.x !== frameB.x || frameA.y !== frameB.y) return false;
		if (frameA.rotation !== frameB.rotation) return false;
		if (frameA.scaleX !== frameB.scaleX || frameA.scaleY !== frameB.scaleY) return false;
	}
	return true;
}
