import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { migrateScholiaSixColorPalette, SCHOLIA_SIX_COLOR_PALETTE } from '../src/color-palette-defaults';

const expectedPalette = {
	Orange: '#ff8c00',
	Green: '#22c55e',
	Yellow: '#ffd400',
	Red: '#ff0000',
	Blue: '#248eff',
	Pink: '#ff69b4',
};

test('ships the requested six named highlight colours in toolbar order', () => {
	assert.deepEqual(SCHOLIA_SIX_COLOR_PALETTE, expectedPalette);
});

test('upgrades the four-colour Scholia default and preserves its selected meaning', () => {
	const settings = {
		colors: {
			'Great Insight!': '#ffd000',
			Controversial: '#ea5252',
			'Conceptual information': '#086ddd',
			'argument premise': '#bb61e5',
		},
		defaultColor: 'Controversial',
		defaultColorPaletteItemIndex: 3,
	};

	assert.equal(migrateScholiaSixColorPalette(settings), true);
	assert.deepEqual(settings.colors, expectedPalette);
	assert.equal(settings.defaultColor, 'Red');
	assert.equal(settings.defaultColorPaletteItemIndex, 5, 'Conceptual information becomes Blue');
});

test('upgrades the older PDF++ defaults to the closest six-colour equivalents', () => {
	const settings = {
		colors: {
			Yellow: '#ffd000',
			Red: '#ea5252',
			Note: '#086ddd',
			Important: '#bb61e5',
		},
		defaultColor: 'Important',
		defaultColorPaletteItemIndex: 1,
	};

	assert.equal(migrateScholiaSixColorPalette(settings), true);
	assert.deepEqual(settings.colors, expectedPalette);
	assert.equal(settings.defaultColor, 'Pink');
	assert.equal(settings.defaultColorPaletteItemIndex, 3, 'Yellow remains Yellow');
});

test('does not overwrite a customised palette', () => {
	const settings = {
		colors: { Evidence: '#123456', Objection: '#abcdef' },
		defaultColor: 'Evidence',
		defaultColorPaletteItemIndex: 2,
	};
	const original = structuredClone(settings);

	assert.equal(migrateScholiaSixColorPalette(settings), false);
	assert.deepEqual(settings, original);
});

test('the six-colour palette is already migrated', () => {
	const settings = {
		colors: { ...expectedPalette },
		defaultColor: 'Orange',
		defaultColorPaletteItemIndex: 1,
	};
	const original = structuredClone(settings);

	assert.equal(migrateScholiaSixColorPalette(settings), false);
	assert.deepEqual(settings, original);
});
