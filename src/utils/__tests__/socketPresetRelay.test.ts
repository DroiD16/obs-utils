import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveGM, isBroadcastOperator } from '../helpers.ts';
import { getSetting, setSetting } from '../settings.ts';

vi.mock('../cameraSequencePlayer.ts', () => ({ playSequence: vi.fn() }));
vi.mock('../canvas', () => ({
	clampAndApplyExternal: vi.fn(),
	getCurrentUser: vi.fn(),
	getLocalViewport: vi.fn(),
	VIEWPORT_DATA: new Map(),
	viewportChanged: vi.fn(),
}));
vi.mock('../helpers.ts', () => ({
	getActiveGM: vi.fn(),
	isBroadcastOperator: vi.fn(() => false),
	isOBS: vi.fn(() => false),
}));
vi.mock('../settings.ts', () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

const getActiveGMMock = vi.mocked(getActiveGM);
const isBroadcastOperatorMock = vi.mocked(isBroadcastOperator);
const getSettingMock = vi.mocked(getSetting);
const setSettingMock = vi.mocked(setSetting);

const PRESET = { id: 'p1', name: 'Preset', x: 0, y: 0, scale: 1 } as any;
const GM_PRIMARY = { id: 'gm-1', isGM: true, active: true };
const GM_SECONDARY = { id: 'gm-2', isGM: true, active: true };

let socketModule: typeof import('../socket.ts');
let handleEvent: (data: any) => Promise<void>;
const socketEmit = vi.fn();

function stubGame(user: { id: string; isGM: boolean }, users: any[] = [GM_PRIMARY, GM_SECONDARY]) {
	vi.stubGlobal('game', {
		user,
		userId: user.id,
		users: { find: (fn: (u: any) => boolean) => users.find(fn) },
		socket: { emit: socketEmit, on: vi.fn() },
	});
}

beforeAll(async () => {
	let initCb: (() => void) | undefined;
	const socketOn = vi.fn();
	vi.stubGlobal('Hooks', {
		once: vi.fn((hook: string, cb: () => void) => {
			if (hook === 'init') initCb = cb;
		}),
		on: vi.fn(),
	});
	vi.stubGlobal('game', { socket: { on: socketOn, emit: socketEmit } });
	socketModule = await import('../socket.ts');
	initCb!();
	handleEvent = socketOn.mock.calls[0][1];
});

beforeEach(() => {
	socketEmit.mockReset();
	setSettingMock.mockReset();
	isBroadcastOperatorMock.mockReturnValue(false);
	getActiveGMMock.mockReturnValue(GM_PRIMARY as any);
	// Values that make orchestratePresetPlay perform every write.
	getSettingMock.mockImplementation((key: string) => {
		if (key === 'defaultInCombat' || key === 'defaultOutOfCombat') return 'trackall';
		if (key === 'activeGMUserId') return '';
		if (key === 'pauseCameraTracking') return false;
		return undefined;
	});
});

describe('sendRequestPresetPlay', () => {
	it('does not emit when the sender is not the operator (stale window)', () => {
		stubGame({ id: 'player-1', isGM: false });
		socketModule.sendRequestPresetPlay(PRESET);
		expect(socketEmit).not.toHaveBeenCalled();
	});

	it('emits the relay event when the sender is the operator', () => {
		stubGame({ id: 'op-1', isGM: false });
		isBroadcastOperatorMock.mockReturnValue(true);
		socketModule.sendRequestPresetPlay(PRESET);
		expect(socketEmit).toHaveBeenCalledExactlyOnceWith('module.obs-utils', {
			eventType: 'requestPresetPlay',
			targetUser: undefined,
			payload: { preset: PRESET },
		});
	});
});

describe('requestPresetPlay handler', () => {
	it('non-GM clients ignore the event', async () => {
		stubGame({ id: 'player-1', isGM: false });
		await handleEvent({ eventType: 'requestPresetPlay', targetUser: undefined, payload: { preset: PRESET } });
		expect(setSettingMock).not.toHaveBeenCalled();
		expect(socketEmit).not.toHaveBeenCalled();
	});

	it('the camera-owning GM orchestrates exactly once: claims control and broadcasts the preset', async () => {
		stubGame(GM_PRIMARY);
		await handleEvent({ eventType: 'requestPresetPlay', targetUser: undefined, payload: { preset: PRESET } });
		expect(setSettingMock).toHaveBeenCalledWith('defaultInCombat', 'cloneDM');
		expect(setSettingMock).toHaveBeenCalledWith('defaultOutOfCombat', 'cloneDM');
		expect(setSettingMock).toHaveBeenCalledWith('activeGMUserId', 'gm-1');
		expect(setSettingMock).toHaveBeenCalledWith('pauseCameraTracking', true);
		const playEmits = socketEmit.mock.calls.filter(([, data]) => data?.eventType === 'playPreset');
		expect(playEmits).toHaveLength(1);
		expect(playEmits[0][1].payload).toEqual({ preset: PRESET });
	});

	it('a GM who does not own the camera does not orchestrate, so the preset is not doubled', async () => {
		stubGame(GM_SECONDARY);
		await handleEvent({ eventType: 'requestPresetPlay', targetUser: undefined, payload: { preset: PRESET } });
		expect(setSettingMock).not.toHaveBeenCalled();
		expect(socketEmit).not.toHaveBeenCalled();
	});

	it('a Co-DM handover is preserved: the GM holding activeGMUserId executes, not the first GM', async () => {
		getActiveGMMock.mockReturnValue(GM_SECONDARY as any);

		stubGame(GM_PRIMARY);
		await handleEvent({ eventType: 'requestPresetPlay', targetUser: undefined, payload: { preset: PRESET } });
		expect(setSettingMock).not.toHaveBeenCalled();
		expect(socketEmit).not.toHaveBeenCalled();

		stubGame(GM_SECONDARY);
		await handleEvent({ eventType: 'requestPresetPlay', targetUser: undefined, payload: { preset: PRESET } });
		expect(setSettingMock).toHaveBeenCalledWith('activeGMUserId', 'gm-2');
		const playEmits = socketEmit.mock.calls.filter(([, data]) => data?.eventType === 'playPreset');
		expect(playEmits).toHaveLength(1);
	});
});
