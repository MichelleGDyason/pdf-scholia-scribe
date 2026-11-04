import * as assert from 'node:assert/strict';

import { formatCitationPageWithOffset, toLowerRoman } from '../src/lib/citation-page';

assert.equal(toLowerRoman(1), 'i');
assert.equal(toLowerRoman(4), 'iv');
assert.equal(toLowerRoman(11), 'xi');
assert.equal(toLowerRoman(49), 'xlix');
assert.equal(toLowerRoman(0), null);

assert.equal(formatCitationPageWithOffset(1, -11, '-10'), 'i');
assert.equal(formatCitationPageWithOffset(11, -11, '0'), 'xi');
assert.equal(formatCitationPageWithOffset(12, -11, '1'), '1');
assert.equal(formatCitationPageWithOffset(31, -11, '20'), '20');
assert.equal(formatCitationPageWithOffset(Number.NaN, -11, 'front'), 'front');

console.log('Citation page formatting tests passed.');
