import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isBroadcastOperator, isOBS } from '../helpers.ts';
import { OBS_MODIFIABLE_SETTINGS, setSetting } from '../settings.ts';

vi.mock('../helpers.ts', () => ({
	isOBS: vi.fn(() => false),
	isBroadcastOperator: vi.fn(() => false),
}));

const isOBSMock = vi.mocked(isOBS);
const isBroadcastOperatorMock = vi.mocked(isBroadcastOperator);

const settingsGet = vi.fn();
const settingsSet = vi.fn();
const socketEmit = vi.fn();

// Current values differ from what the tests write, so setSetting never takes
// the value-unchanged early return.
const CURRENT_VALUES: Record<string, unknown> = {
	trackedUser: 'someone-else',
	cameraTrackingMode: 'smooth',
	cameraSmoothing: 400,
	cameraEasing: 'easeOutCircle',
	activeGMUserId: '',
	showDirectorInOBSMode: false,
};

function stubEnvironment({ isGM = false, hasActiveGM = true, showDirectorInOBSMode = false } = {}) {
	settingsGet.mockImplementation((_ns: string, key: string) =>
		key === 'showDirectorInOBSMode' ? showDirectorInOBSMode : CURRENT_VALUES[key]);
	vi.stubGlobal('game', {
		// Keep `ready` falsy so store revert paths don't re-enter setSetting.
		ready: false,
		user: { id: 'op-1', isGM },
		users: { some: (fn: (u: any) => boolean) => hasActiveGM && fn({ isGM: true, active: true }) },
		socket: { emit: socketEmit },
		settings: {
			get: settingsGet,
			set: settingsSet,
			settings: new Map(
				Object.keys(CURRENT_VALUES).map(k => [`obs-utils.${k}`, { scope: 'world' }]),
			),
		},
	});
	vi.stubGlobal('Hooks', { on: vi.fn(), once: vi.fn(), off: vi.fn() });
}

describe('setSetting relay', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		settingsGet.mockReset();
		settingsSet.mockReset();
		socketEmit.mockReset();
		isOBSMock.mockReturnValue(false);
		isBroadcastOperatorMock.mockReturnValue(false);
	});

	it('whitelist includes the three camera keys', () => {
		expect(OBS_MODIFIABLE_SETTINGS.has('cameraTrackingMode')).toBe(true);
		expect(OBS_MODIFIABLE_SETTINGS.has('cameraSmoothing')).toBe(true);
		expect(OBS_MODIFIABLE_SETTINGS.has('cameraEasing')).toBe(true);
	});

	it('a GM writes the setting directly, no relay', async () => {
		stubEnvironment({ isGM: true });
		await setSetting('trackedUser', 'player-9');
		expect(settingsSet).toHaveBeenCalledWith('obs-utils', 'trackedUser', 'player-9');
		expect(socketEmit).not.toHaveBeenCalled();
	});

	it.each([
		['trackedUser', 'player-9'],
		['cameraTrackingMode', 'raw'],
		['cameraSmoothing', 800],
		['cameraEasing', 'linear'],
	] as const)('operator relays whitelisted key %s over the socket', async (key, value) => {
		stubEnvironment();
		isBroadcastOperatorMock.mockReturnValue(true);
		await setSetting(key, value as never);
		expect(socketEmit).toHaveBeenCalledWith('module.obs-utils', {
			action: 'setPlayerModifiableSetting',
			settingName: key,
			value,
			userId: 'op-1',
		});
		expect(settingsSet).not.toHaveBeenCalled();
	});

	it('operator neither emits nor writes for a key outside the whitelist', async () => {
		stubEnvironment();
		isBroadcastOperatorMock.mockReturnValue(true);
		await setSetting('activeGMUserId', 'op-1');
		expect(socketEmit).not.toHaveBeenCalled();
		expect(settingsSet).not.toHaveBeenCalled();
	});

	it('operator does not emit when no GM is active', async () => {
		stubEnvironment({ hasActiveGM: false });
		isBroadcastOperatorMock.mockReturnValue(true);
		await setSetting('trackedUser', 'player-9');
		expect(socketEmit).not.toHaveBeenCalled();
		expect(settingsSet).not.toHaveBeenCalled();
	});

	it('regular player writing a world setting is silently reverted', async () => {
		stubEnvironment();
		await setSetting('trackedUser', 'player-9');
		expect(socketEmit).not.toHaveBeenCalled();
		expect(settingsSet).not.toHaveBeenCalled();
	});

	it('the OBS-mode director path still relays without the operator role', async () => {
		stubEnvironment({ showDirectorInOBSMode: true });
		isOBSMock.mockReturnValue(true);
		await setSetting('trackedUser', 'player-9');
		expect(socketEmit).toHaveBeenCalledOnce();
	});
});
