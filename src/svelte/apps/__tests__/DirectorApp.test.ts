import { flushSync, mount, unmount } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getApi, getGM, isBroadcastOperator } from '../../../utils/helpers.ts';
import DirectorApp from '../DirectorApp.svelte';
import DummyTab from './DummyTab.svelte';

vi.mock('../../../utils/helpers.ts', () => ({
	getApi: vi.fn(),
	getGM: vi.fn(),
	isBroadcastOperator: vi.fn(() => false),
}));

const getApiMock = vi.mocked(getApi);
const getGMMock = vi.mocked(getGM);
const isBroadcastOperatorMock = vi.mocked(isBroadcastOperator);

function makeTabs() {
	return new Map([
		['core.controls', { key: 'core.controls', label: 'tabControls', component: DummyTab, order: 10 }],
		['core.presets', { key: 'core.presets', label: 'tabPresets', component: DummyTab, order: 20 }],
		['core.codms', { key: 'core.codms', label: 'tabCoDMs', component: DummyTab, order: 30 }],
	]);
}

// Captured 'userConnected' hook callback, so tests can simulate a GM leaving.
let userConnectedCb: (() => void) | undefined;

function mountApp() {
	document.body.innerHTML = '<div id="target"></div>';
	const target = document.getElementById('target')!;
	const instance = mount(DirectorApp, { target });
	flushSync();
	return { instance, target };
}

describe('directorApp tabs and gate', () => {
	beforeEach(() => {
		userConnectedCb = undefined;
		getApiMock.mockReturnValue({ directorTabs: makeTabs() } as any);
		getGMMock.mockReturnValue({ active: true } as any);
		isBroadcastOperatorMock.mockReturnValue(false);
		vi.stubGlobal('game', { i18n: { localize: (k: string) => k } });
		vi.stubGlobal('Hooks', {
			on: vi.fn((hook: string, cb: () => void) => {
				if (hook === 'userConnected') userConnectedCb = cb;
			}),
			off: vi.fn(),
		});
	});

	it('a GM (or OBS director) sees all registered tabs', () => {
		const { instance, target } = mountApp();
		const labels = Array.from(target.querySelectorAll('.tab-bar button span')).map(el => el.textContent);
		expect(labels).toEqual(['tabControls', 'tabPresets', 'tabCoDMs']);
		unmount(instance);
	});

	it('the broadcast operator only sees Controls and Presets', () => {
		isBroadcastOperatorMock.mockReturnValue(true);
		const { instance, target } = mountApp();
		const labels = Array.from(target.querySelectorAll('.tab-bar button span')).map(el => el.textContent);
		expect(labels).toEqual(['tabControls', 'tabPresets']);
		unmount(instance);
	});

	it('the no-GM gate reacts to a GM disconnecting while the window is open', () => {
		const { instance, target } = mountApp();
		expect(target.querySelector('.warning')).toBeNull();

		getGMMock.mockReturnValue(undefined);
		userConnectedCb!();
		flushSync();

		expect(target.querySelector('.warning')).not.toBeNull();
		unmount(instance);
	});
});
