// Compact roll text for `core.onPlayerRoll` overlays: banners have room for
// "Perception" and "1d20+3", not "Wisdom (Perception) Check (Advantage)" and
// "1d20 + 2 + 1".

const ROLL_MODE_SUFFIX = /\s*\((?:Advantage|Disadvantage|Normal)\)\s*$/i;
// dnd5e item rolls: "<item> - Attack Roll" / "Damage Roll" / "Healing Roll" / "Other Formula".
const ITEM_ROLL = /^(.+) - (?:Attack Roll|Damage Roll|Healing Roll|Other Formula)$/;

/** Label for a dnd5e check or save flavor, or undefined when `text` is neither. */
function checkLabel(text: string): string | undefined {
	const skill = text.match(/^\S+ \((.+)\) Check$/);
	if (skill) return skill[1];
	const ability = text.match(/^(.+) Ability Check$/);
	if (ability) return ability[1];
	const save = text.match(/^(.+) Saving Throw$/);
	if (save) return `${save[1]} Save`;
	const tool = text.match(/^(.+) Check$/);
	if (tool) return tool[1];
	return undefined;
}

/**
 * Short label from a chat-message flavor. Recognises the dnd5e roll flavors;
 * anything else comes back trimmed and stripped of HTML, and an empty flavor
 * becomes "Roll".
 *  - "Wisdom (Perception) Check (Advantage)" → "Perception"
 *  - "Charisma Ability Check" → "Charisma"
 *  - "Constitution Saving Throw" → "Constitution Save"
 *  - "Thieves' Tools Check" → "Thieves' Tools"
 *  - "Scimitar - Attack Roll", "Bite - Damage Roll" → "Scimitar", "Bite"
 *  - "Fraen Torn - Charisma (Persuasion) Check" (actor-prefixed) → "Persuasion"
 */
export function shortRollLabel(flavor: string): string {
	const text = flavor.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().replace(ROLL_MODE_SUFFIX, '');
	if (!text) return 'Roll';
	const item = text.match(ITEM_ROLL);
	if (item) return item[1];
	const check = checkLabel(text);
	const dash = text.lastIndexOf(' - ');
	if (dash > 0) {
		const prefixed = checkLabel(text.slice(dash + 3));
		if (prefixed) return prefixed;
	}
	return check ?? text;
}

/**
 * Formula with its flat modifiers folded into one number and spaces removed:
 * "1d20 + 2 + 1" → "1d20+3", "1d20 + 0" → "1d20", "2d6 + 3 - 1" → "2d6+2".
 * Formulas with anything beyond `+`/`-` between terms (parentheses, `*`, `/`)
 * are returned with spaces removed only.
 */
export function shortRollFormula(formula: string): string {
	const compact = formula.replace(/\s+/g, '');
	if (/[()*/]/.test(compact)) return compact;
	const terms = compact.match(/[+-]?[^+-]+/g) ?? [];
	let flat = 0;
	const dice: string[] = [];
	for (const term of terms) {
		if (/^[+-]?\d+$/.test(term)) flat += Number(term);
		else dice.push(term);
	}
	if (dice.length === 0) return String(flat);
	let out = dice.map((d, i) => (i === 0 ? d.replace(/^\+/, '') : /^[+-]/.test(d) ? d : `+${d}`)).join('');
	if (flat > 0) out += `+${flat}`;
	else if (flat < 0) out += String(flat);
	return out;
}
