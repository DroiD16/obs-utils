import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from '../settings.ts';

vi.mock('../settings.ts', () => ({
	ensureStore: vi.fn(() => ({ set: vi.fn() })),
	getSetting: vi.fn(),
	setSetting: vi.fn(),
	OBS_MODIFIABLE_SETTINGS: new Set(['trackedUser', 'cameraTrackingMode', 'cameraSmoothing', 'cameraEasing']),
}));
vi.mock('../canvas.ts', () => ({ scaleToFit: vi.fn(), tokenMoved: vi.fn(), viewportChanged: vi.fn() }));
vi.mock('../helpers.ts', () => ({ getGM: vi.fn(), isOBS: vi.fn(() => false) }));
vi.mock('../types.ts', () => ({ OBSRemoteSettings: class {}, OBSWebsocketSettings: class {} }));

const setSettingMock = vi.mocked(setSetting);

// The GM-side socket handler registered by setupOBSModifiableSettingsSocket.
let handler: (data: any) => Promise<void>;

const GM_PRIMARY = { id: 'gm-1', isGM: true, active: true };
const GM_SECONDARY = { id: 'gm-2', isGM: true, active: true };

function stubGame(user: { id: string; isGM: boolean }, users: any[]) {
	vi.stubGlobal('game', {
		user,
		users: {
			find: (fn: (u: any) => boolean) => users.find(fn),
		},
		socket: { on: vi.fn() },
	});
}

beforeAll(async () => {
	let readyCb: (() => void) | undefined;
	const socketOn = vi.fn();
	vi.stubGlobal('Hooks', {
		once: vi.fn((hook: string, cb: () => void) => {
			if (hook === 'ready') readyCb = cb;
		}),
		on: vi.fn(),
	});
	vi.stubGlobal('game', { socket: { on: socketOn } });
	await import('../settingsSetup.ts');
	readyCb!();
	handler = socketOn.mock.calls[0][1];
});

describe('setPlayerModifiableSetting GM handler', () => {
	beforeEach(() => {
		setSettingMock.mockReset();
	});

	it('ignores events on non-GM clients', async () => {
		stubGame({ id: 'player-1', isGM: false }, [GM_PRIMARY]);
		await handler({ action: 'setPlayerModifiableSetting', settingName: 'trackedUser', value: 'x', userId: 'op-1' });
		expect(setSettingMock).not.toHaveBeenCalled();
	});

	it('ignores unrelated actions', async () => {
		stubGame(GM_PRIMARY, [GM_PRIMARY]);
		await handler({ action: 'somethingElse', settingName: 'trackedUser', value: 'x' });
		expect(setSettingMock).not.toHaveBeenCalled();
	});

	it('rejects setting names outside the whitelist', async () => {
		stubGame(GM_PRIMARY, [GM_PRIMARY]);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await handler({ action: 'setPlayerModifiableSetting', settingName: 'activeGMUserId', value: 'op-1', userId: 'op-1' });
		expect(setSettingMock).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('primary GM applies a whitelisted setting', async () => {
		stubGame(GM_PRIMARY, [GM_PRIMARY, GM_SECONDARY]);
		await handler({ action: 'setPlayerModifiableSetting', settingName: 'cameraTrackingMode', value: 'raw', userId: 'op-1' });
		expect(setSettingMock).toHaveBeenCalledExactlyOnceWith('cameraTrackingMode', 'raw');
	});

	it('secondary GM stays silent so the write happens once', async () => {
		stubGame(GM_SECONDARY, [GM_PRIMARY, GM_SECONDARY]);
		await handler({ action: 'setPlayerModifiableSetting', settingName: 'cameraTrackingMode', value: 'raw', userId: 'op-1' });
		expect(setSettingMock).not.toHaveBeenCalled();
	});
});
