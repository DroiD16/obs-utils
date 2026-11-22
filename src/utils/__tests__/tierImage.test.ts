import { describe, expect, it } from 'vitest';
import { resolveComponentValues } from '../render.ts';

const GEM = 'system.attributes.hp.value+system.attributes.hp.temp;system.attributes.hp.effectiveMax;>50:green.png;>=25:yellow.png;>0:red.png;black.png';

function hp(value: number, effectiveMax: number, temp: number | null = null) {
	return { system: { attributes: { hp: { value, temp, effectiveMax } } } };
}

function gem(actor: unknown) {
	return resolveComponentValues('tierimg', GEM, actor, undefined);
}

describe('tierimg', () => {
	it('picks the first rule the percentage satisfies', () => {
		expect(gem(hp(60, 60)).value).toBe('green.png');
		expect(gem(hp(31, 60)).value).toBe('green.png');
		expect(gem(hp(30, 60)).value).toBe('yellow.png');
		expect(gem(hp(15, 60)).value).toBe('yellow.png');
		expect(gem(hp(14, 60)).value).toBe('red.png');
		expect(gem(hp(1, 200)).value).toBe('red.png');
	});

	it('falls back to the unconditioned image at zero', () => {
		expect(gem(hp(0, 60)).value).toBe('black.png');
	});

	it('sums every +-joined value path and treats missing ones as zero', () => {
		const r = gem(hp(20, 60, 10));
		expect(r.pct).toBe(50);
		expect(r.value).toBe('yellow.png');
		expect(gem(hp(31, 60, null)).value).toBe('green.png');
	});

	it('clamps the percentage to 0..100', () => {
		expect(gem(hp(60, 60, 30)).pct).toBe(100);
		expect(gem(hp(-5, 60)).pct).toBe(0);
	});

	it('shows nothing when the max is missing or zero', () => {
		expect(gem(hp(10, 0))).toEqual({ value: '', pct: '' });
		expect(gem({ system: {} })).toEqual({ value: '', pct: '' });
		expect(gem(undefined)).toEqual({ value: '', pct: '' });
	});

	it('reads trigger paths and keeps colons inside image urls', () => {
		const data = 'trigger.v;trigger.m;>=50:https://x.test/a.png;https://x.test/b.png';
		expect(resolveComponentValues('tierimg', data, undefined, { v: 5, m: 10 }).value).toBe('https://x.test/a.png');
		expect(resolveComponentValues('tierimg', data, undefined, { v: 4, m: 10 }).value).toBe('https://x.test/b.png');
	});
});
