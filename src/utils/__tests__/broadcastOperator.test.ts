import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBroadcastOperator } from '../helpers.ts';

function stubGame(opts: { operatorId?: string; userId?: string; isGM?: boolean }) {
	vi.stubGlobal('game', {
		settings: {
			get: (_ns: string, key: string) =>
				key === 'broadcastOperatorUserId' ? opts.operatorId : undefined,
		},
		user: { id: opts.userId, isGM: opts.isGM ?? false },
	});
}

describe('isBroadcastOperator', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('accepts the assigned non-GM user', () => {
		stubGame({ operatorId: 'player-1', userId: 'player-1', isGM: false });
		expect(isBroadcastOperator()).toBe(true);
	});

	it('rejects the "none" sentinel', () => {
		stubGame({ operatorId: 'none', userId: 'none', isGM: false });
		expect(isBroadcastOperator()).toBe(false);
	});

	it('rejects an unset setting', () => {
		stubGame({ operatorId: undefined, userId: 'player-1', isGM: false });
		expect(isBroadcastOperator()).toBe(false);
	});

	it('rejects a user other than the assigned one', () => {
		stubGame({ operatorId: 'player-1', userId: 'player-2', isGM: false });
		expect(isBroadcastOperator()).toBe(false);
	});

	it('rejects a GM even if their id is assigned', () => {
		stubGame({ operatorId: 'gm-1', userId: 'gm-1', isGM: true });
		expect(isBroadcastOperator()).toBe(false);
	});
});
