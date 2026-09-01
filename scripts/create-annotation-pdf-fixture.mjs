import {
	PDFDocument,
	PDFHexString,
	PDFString,
	rgb,
} from '@cantoo/pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

const outputPath = new URL('../tests/fixtures/annotated-preview.pdf', import.meta.url);
await mkdir(new URL('../tests/fixtures/', import.meta.url), { recursive: true });

const pdf = await PDFDocument.create();
pdf.setTitle('Synthetic Preview Annotation Fixture');
pdf.setAuthor('PDF Scholia Scribe tests');
const page = pdf.addPage([612, 792]);
page.drawText('Synthetic annotated passage for PDF Scholia Scribe.', {
	x: 72,
	y: 700,
	size: 16,
	color: rgb(0.08, 0.08, 0.1),
});
page.drawText('This file contains no personal or research-library data.', {
	x: 72,
	y: 660,
	size: 11,
	color: rgb(0.25, 0.25, 0.3),
});

const addAnnotation = (dictionary) => {
	const reference = pdf.context.register(pdf.context.obj({ Type: 'Annot', ...dictionary }));
	page.node.addAnnot(reference);
};

addAnnotation({
	Subtype: 'Highlight',
	Rect: [70, 696, 500, 718],
	QuadPoints: [70, 718, 500, 718, 70, 696, 500, 696],
	Contents: PDFHexString.fromText('A preserved Preview highlight comment.'),
	T: PDFHexString.fromText('Synthetic reviewer'),
	M: PDFString.fromDate(new Date('2026-01-02T03:04:05Z')),
	C: [1, 0.82, 0.12],
	CA: 0.35,
});

addAnnotation({
	Subtype: 'Text',
	Rect: [72, 610, 94, 632],
	Contents: PDFHexString.fromText('A sticky-note comment from Preview.'),
	T: PDFHexString.fromText('Synthetic reviewer'),
	M: PDFString.fromDate(new Date('2026-01-03T03:04:05Z')),
	C: [0.35, 0.65, 0.95],
	Name: 'Comment',
});

addAnnotation({
	Subtype: 'FreeText',
	Rect: [72, 540, 360, 585],
	Contents: PDFHexString.fromText('A Preview text box.'),
	T: PDFHexString.fromText('Synthetic reviewer'),
	M: PDFString.fromDate(new Date('2026-01-04T03:04:05Z')),
	C: [0.4, 0.75, 0.42],
	DA: PDFString.of('/Helvetica 12 Tf 0 g'),
});

addAnnotation({
	Subtype: 'Ink',
	Rect: [70, 455, 260, 510],
	InkList: [[75, 470, 115, 500, 165, 462, 225, 495]],
	Contents: PDFHexString.fromText('Handwritten ink retained; no OCR claimed.'),
	T: PDFHexString.fromText('Synthetic reviewer'),
	M: PDFString.fromDate(new Date('2026-01-05T03:04:05Z')),
	C: [0.65, 0.25, 0.75],
	Border: [0, 0, 2],
});

addAnnotation({
	Subtype: 'Redact',
	Rect: [70, 400, 250, 425],
	Contents: PDFHexString.fromText('Synthetic redaction must not be imported.'),
	T: PDFHexString.fromText('Synthetic reviewer'),
	C: [0, 0, 0],
});

await writeFile(outputPath, await pdf.save({ useObjectStreams: false }));
