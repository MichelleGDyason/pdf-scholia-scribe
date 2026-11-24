import * as assert from 'node:assert/strict';

import { selectAssociatedMarkdownFile, selectCitationMetadataSources } from '../src/template-associated-markdown';

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

type TestProperties = Record<string, string | number>;

const associatedProperties: TestProperties = { author: 'Soubry and Sherren', year: 2022 };
const destinationProperties: TestProperties = { author: 'Dyason', title: 'resilience' };
const explicitFallbackProperties: TestProperties = { author: 'Fallback author', year: 2021 };
const associatedSource = { path: 'Sources/Soubry and Sherren.md' };
const destinationNote = { path: 'Notes/resilience.md' };
const explicitFallback = { path: 'Sources/Explicit fallback.md' };

assert.deepEqual(
    selectCitationMetadataSources(associatedSource, associatedProperties, [
        { file: destinationNote, properties: destinationProperties, pointsToPdf: false },
        { file: explicitFallback, properties: explicitFallbackProperties, pointsToPdf: true },
    ]),
    [
        { file: associatedSource, properties: associatedProperties, pointsToPdf: true },
        { file: explicitFallback, properties: explicitFallbackProperties, pointsToPdf: true },
    ],
    'uses the associated source first and excludes unrelated destination-note metadata',
);

assert.deepEqual(
    selectCitationMetadataSources(associatedSource, associatedProperties, [
        { file: associatedSource, properties: destinationProperties, pointsToPdf: true },
    ]),
    [{ file: associatedSource, properties: associatedProperties, pointsToPdf: true }],
    'does not add the associated source twice',
);

assert.deepEqual(
    selectCitationMetadataSources<TestFile, TestProperties>(null, destinationProperties, [
        { file: destinationNote, properties: destinationProperties, pointsToPdf: false },
    ]),
    [],
    'does not treat an unrelated destination note as citation metadata when no source note is associated',
);

console.log('Template associated-markdown selection tests passed.');
