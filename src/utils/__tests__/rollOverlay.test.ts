import { describe, expect, it } from 'vitest';
import { getRollImageSource } from '../rollOverlay.ts';

describe('getRollImageSource', () => {
	it('adds a roll sequence to a plain path', () => {
		expect(getRollImageSource('icons/roll.gif', 3)).toBe('icons/roll.gif?obsUtilsRoll=3');
	});

	it('preserves existing query parameters', () => {
		expect(getRollImageSource('icons/roll.gif?foo=bar', 4)).toBe('icons/roll.gif?foo=bar&obsUtilsRoll=4');
	});

	it('preserves hash fragments', () => {
		expect(getRollImageSource('icons/roll.gif?foo=bar#frame', 5)).toBe('icons/roll.gif?foo=bar&obsUtilsRoll=5#frame');
	});

	it('leaves empty paths empty', () => {
		expect(getRollImageSource('', 6)).toBe('');
	});
});
