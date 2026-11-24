export interface ColorPaletteSettings {
	colors: Record<string, string>;
	defaultColor: string;
	defaultColorPaletteItemIndex: number;
}

export const SCHOLIA_SIX_COLOR_PALETTE: Record<string, string> = {
	Orange: '#ff8c00',
	Green: '#22c55e',
	Yellow: '#ffd400',
	Red: '#ff0000',
	Blue: '#248eff',
	Pink: '#ff69b4',
};

interface PreviousDefaultPalette {
	colors: Record<string, string>;
	replacements: Record<string, string>;
}

const PRE_SCHOLIA_DEFAULT_PALETTE: PreviousDefaultPalette = {
	colors: {
		Yellow: '#ffd000',
		Red: '#ea5252',
		Note: '#086ddd',
		Important: '#bb61e5',
	},
	replacements: {
		Yellow: 'Yellow',
		Red: 'Red',
		Note: 'Blue',
		Important: 'Pink',
	},
};

const SCHOLIA_FOUR_COLOR_PALETTE: PreviousDefaultPalette = {
	colors: {
		'Great Insight!': '#ffd000',
		Controversial: '#ea5252',
		'Conceptual information': '#086ddd',
		'argument premise': '#bb61e5',
	},
	replacements: {
		'Great Insight!': 'Yellow',
		Controversial: 'Red',
		'Conceptual information': 'Blue',
		'argument premise': 'Pink',
	},
};

const PREVIOUS_DEFAULT_PALETTES = [PRE_SCHOLIA_DEFAULT_PALETTE, SCHOLIA_FOUR_COLOR_PALETTE];

function palettesMatch(actual: Record<string, string>, expected: Record<string, string>): boolean {
	const entries = Object.entries(actual);
	return entries.length === Object.keys(expected).length
		&& entries.every(([name, color]) => expected[name]?.toLowerCase() === color.toLowerCase());
}

/** Upgrade only an untouched historical default palette, preserving genuinely custom palettes. */
export function migrateScholiaSixColorPalette(settings: ColorPaletteSettings): boolean {
	const previous = PREVIOUS_DEFAULT_PALETTES.find(({ colors }) => palettesMatch(settings.colors, colors));
	if (!previous) return false;

	const previousNames = Object.keys(previous.colors);
	const selectedName = settings.defaultColorPaletteItemIndex > 0
		? previousNames[settings.defaultColorPaletteItemIndex - 1]
		: '';
	const replacementSelectedName = previous.replacements[selectedName];

	settings.colors = { ...SCHOLIA_SIX_COLOR_PALETTE };
	settings.defaultColor = settings.defaultColor
		? previous.replacements[settings.defaultColor] ?? ''
		: '';
	settings.defaultColorPaletteItemIndex = replacementSelectedName
		? Object.keys(settings.colors).indexOf(replacementSelectedName) + 1
		: 0;
	return true;
}
