import { describe, expect, it } from 'vitest';
import { shortRollFormula, shortRollLabel } from '../rollText.ts';

describe('shortRollLabel', () => {
	it.each([
		['Wisdom (Perception) Check', 'Perception'],
		['Charisma (Deception) Check (Advantage)', 'Deception'],
		['Charisma Ability Check', 'Charisma'],
		['Constitution Saving Throw', 'Constitution Save'],
		['Constitution Saving Throw (Advantage)', 'Constitution Save'],
		['Dexterity Saving Throw (Disadvantage)', 'Dexterity Save'],
		['Longsword - Attack Roll', 'Longsword - Attack Roll'],
		['<span>Fireball</span> Damage', 'Fireball Damage'],
		['', ''],
	])('%j → %j', (flavor, label) => {
		expect(shortRollLabel(flavor)).toBe(label);
	});
});

describe('shortRollFormula', () => {
	it.each([
		['1d20 + 2 + 1', '1d20+3'],
		['1d20 + 0', '1d20'],
		['1d20 + 4 + 1', '1d20+5'],
		['1d20 + 0 + 2 + 1 + 0', '1d20+3'],
		['2d6 + 3 - 1', '2d6+2'],
		['1d8 + 1d6 + 3', '1d8+1d6+3'],
		['1d20 - 2', '1d20-2'],
		['2d20kh + 5', '2d20kh+5'],
		['4 + 7', '11'],
		['(1d6 + 2) * 2', '(1d6+2)*2'],
		['1d10', '1d10'],
	])('%j → %j', (formula, short) => {
		expect(shortRollFormula(formula)).toBe(short);
	});
});
