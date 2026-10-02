import * as assert from 'node:assert/strict';

import { selectAssociatedMarkdownFile } from '../src/template-associated-markdown';

type TestFile = { path: string };

const firstPart = { path: 'Notes/Book - part 1.md' };
const secondPart = { path: 'Notes/Book - part 2.md' };
const thirdPart = { path: 'Notes/Book - part 3.md' };

assert.equal(
    selectAssociatedMarkdownFile([firstPart, secondPart, thirdPart], [secondPart]),
    secondPart,
    'uses the active split note when it is associated with the PDF',
);

assert.equal(
    selectAssociatedMarkdownFile([firstPart, secondPart, thirdPart], [{ path: 'Other.md' }, thirdPart]),
    thirdPart,
    'falls through to the next applicable linked or open note',
);

assert.equal(
    selectAssociatedMarkdownFile([thirdPart, firstPart, secondPart], []),
    firstPart,
    'uses a deterministic path-sorted fallback when no associated note is active',
);

assert.equal(selectAssociatedMarkdownFile<TestFile>([], [firstPart]), null, 'returns null when no note is associated');

console.log('Template associated-markdown selection tests passed.');
