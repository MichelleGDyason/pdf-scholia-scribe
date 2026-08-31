# External annotation import: continuation brief

Status: staged for implementation after PDF Scholia Scribe 1.2.1.

## Outcome

Add a read-only **Import annotations from reading apps** workflow that writes selected annotations into the active Obsidian Markdown note. The first adapters are:

1. Kindle exports, beginning with `My Clippings.txt` and Kindle Scribe PDF exports.
2. Apple Books shared/exported highlights and notes.
3. PDFs annotated by Apple Preview.

The importer must preserve every field the source actually supplies: quoted text, comment, colour, annotation type, page or location, date, author, source title, and a useful link back to the source. It must never edit the source export, application library, or PDF.

## Product boundary

- Import is user-initiated into the currently open Markdown note.
- A preview and explicit item selection happen before the note changes.
- Re-import refreshes provider/document sections by stable IDs instead of duplicating them.
- Source files and application databases are read-only.
- No Amazon or Apple credentials, browser scraping, cloud-session reuse, or hidden background sync.
- Do not claim handwriting recognition. If Kindle Scribe or another application exports recognised text, preserve that supplied text; Scholia does not perform handwriting OCR itself.
- Flattened PDF marks have no editable annotation objects and therefore cannot always be recovered.

## Existing seams to reuse

- `src/lib/zotero-references.ts` already implements bounded managed sections, colour-preserving Markdown, stable refresh markers, note-section deduplication, and editor scroll preservation.
- `src/lib/highlights/extract.ts` already walks a PDF with PDF.js, reads text-markup annotations, maps `quadPoints` back to page text, and retrieves colour and comments.
- `PDFPlusLib.loadPDFDocument()` and `loadPDFDocumentFromArrayBuffer()` already provide the PDF.js loading path.
- `src/modals/dummy-file-modals.ts` contains the guarded desktop Electron file-picker pattern. The new workflow should wrap this rather than duplicating private Electron access in every adapter.
- `src/lib/commands.ts` already checks for an active Markdown view before opening an import modal.

The Zotero-specific types should not be stretched to represent all providers. Extract their reusable managed-block and Markdown-rendering behaviour behind a new provider-neutral manager.

## Shared data contract

Create `src/lib/annotation-import.ts` with a normalized model resembling:

```ts
type AnnotationProvider = 'zotero' | 'kindle' | 'apple-books' | 'apple-preview';

interface ImportedAnnotation {
    provider: AnnotationProvider;
    documentId: string;
    annotationId: string;
    documentTitle: string;
    documentAuthor?: string;
    type: 'highlight' | 'underline' | 'strikeout' | 'note' | 'text' | 'ink' | 'shape' | 'stamp' | 'bookmark' | 'unknown';
    text?: string;
    comment?: string;
    color?: string;
    colorLabel?: string;
    pageLabel?: string;
    pageNumber?: number;
    locationLabel?: string;
    locationStart?: number;
    locationEnd?: number;
    createdAt?: string;
    modifiedAt?: string;
    author?: string;
    sourceLink?: string;
    sourcePath?: string;
}

interface AnnotationDocument {
    provider: AnnotationProvider;
    documentId: string;
    title: string;
    author?: string;
    annotations: ImportedAnnotation[];
    warnings: string[];
}

interface AnnotationImportAdapter {
    provider: AnnotationProvider;
    accepts(fileName: string, mediaType?: string): boolean;
    parse(input: ArrayBuffer, context: { fileName: string }): Promise<AnnotationDocument[]>;
}
```

Stable refresh markers should be provider/document scoped:

```text
<!-- scholia-import:kindle:<document-id>:start -->
<!-- scholia-import:kindle:<document-id>:end -->
```

Never use titles alone as IDs. Hash stable source identity plus source annotation identity when a format has no native ID. Do not include source text or personal identifiers in the hash input when a less sensitive stable field exists.

## Kindle adapter

### Phase 1: `My Clippings.txt`

- Accept UTF-8/UTF-8-BOM text and tolerate CRLF or LF.
- Split records on Kindle's `==========` separator.
- Parse title/author, highlight/note/bookmark type, page, location range, and date when present.
- Keep the original metadata line as a fallback when localization or an unknown Kindle version defeats structured parsing.
- Pair a note with an adjacent highlight only when their book identity and location match; otherwise retain both separately.
- Deduplicate repeated clippings using normalized book identity, type, location, and body.
- Preserve warnings per record rather than dropping malformed records silently.

Required synthetic fixtures:

- UTF-8 BOM and CRLF.
- Highlight, note, and bookmark records.
- Page-only, location-only, and page-plus-location metadata.
- Duplicate records.
- A record with an unknown/localized metadata label.
- Delimiter-like text inside the clipping body.

### Phase 2: Kindle Scribe exports

Amazon documents that Scribe can export notebooks and annotations and, on supported newer devices, can provide a searchable PDF created by its own handwriting conversion. Treat these as user-selected PDFs. Reuse the PDF adapter for embedded annotations and extract already-recognised text where the export supplies it. Do not describe this as Scholia handwriting OCR.

Do not implement Kindle cloud scraping. Export links can expire and authenticated notebook pages are not a stable plugin API.

## Apple Books adapter

Apple documents highlights, underlines, notes, colours, navigation back to a highlight, and sharing selected annotations. There is no public, stable Apple Books annotation API documented for third-party Obsidian plugins.

Implement in this order:

1. User-shared text/HTML exports selected through the importer or pasted into it.
2. PDFs from Apple Books through the same standard PDF adapter used for Preview.
3. Only after representative fixtures exist, consider an advanced macOS database import.

The first Apple Books parser must be fixture-driven because Share-sheet output can vary by OS version, locale, book type, and destination application. Preserve unparsed location/citation strings visibly.

An optional database reader must meet all of these conditions:

- explicit user selection of the database file or folder;
- read-only SQLite access, ideally to a temporary snapshot so a live WAL cannot produce inconsistent results;
- no scanning of `~/Library` without the user choosing that route;
- no database writes, migrations, cleanup, or metadata correction;
- schema probing with clear unsupported-version messages;
- no dependency on hard-coded private paths as the only workflow.

Before implementing the database path, collect privacy-safe schema facts and small synthetic fixtures. Never commit a real Apple Books database or personal annotation text.

## Apple Preview PDF adapter

Apple states that Preview preserves editable annotations when a PDF is saved or exported normally; printing to PDF flattens them. This makes standard PDF annotation extraction the primary route.

Extend `src/lib/highlights/extract.ts` rather than creating a Preview-only PDF parser. Support at least:

- `Highlight`, `Underline`, `Squiggly`, and `StrikeOut` with text recovered through `quadPoints`;
- `Text`/sticky notes and `FreeText` using `contentsObj.str`;
- `Ink`, `Stamp`, shapes, lines, and polygons as labelled entries when no useful text exists;
- colour, author/title object, creation/modification date, page, annotation ID, and comment when PDF.js exposes them.

Generate vault links in the existing form:

```text
[[Document.pdf#page=12&annotation=<id>]]
```

For PDFs outside the vault, first offer a read-only file selection and import the annotations without moving the PDF. A later option may use the existing dummy-file mechanism to retain an external-file link, but it must remain explicit.

Skip signatures and redactions by default. Report them in the preview as unsupported/sensitive rather than silently importing their appearance data. A flattened mark should produce a document warning, not a fabricated annotation.

Required synthetic PDF fixtures:

- text highlight with colour and comment;
- underline and strikeout;
- sticky note and free-text box;
- ink annotation with and without `/Contents`;
- author and date metadata;
- a flattened visual mark with no annotation object;
- a multi-page PDF for deterministic page ordering.

## User interface

Add one command, **Import annotations from reading apps**, while retaining the existing Zotero command for compatibility.

Suggested modal flow:

1. Choose source: Zotero, Kindle, Apple Books, or annotated PDF.
2. Select one or more source files, or use Zotero's local search.
3. Show detected documents, annotation counts, unsupported-item counts, and warnings.
4. Select documents/annotations.
5. Import into the active Markdown note.

The preview should use source-specific language: page for PDFs, location for Kindle, and the original location label for Apple Books. It must state when colour, page, or text is unavailable rather than inventing values.

## Verification and safety gates

- Unit-test every parser with synthetic, non-personal fixtures.
- Test malformed and partially supported inputs; parsing one bad record must not abort the entire import.
- Test stable re-import and cross-provider ID collisions.
- Test that no input file changes by comparing hashes before and after import.
- Run `npm run build`, `npm run lint:obsidian`, and `git diff --check`.
- Live-test against a disposable Markdown note before touching a real destination note.
- Verify mobile gracefully hides desktop-only local-file/database routes.
- Scan the final bundle for dynamic script creation and unintended cloud endpoints.
- Update README, manifest description if warranted, and privacy/safety disclosures before release.

## Restart point

1. Stay on branch `codex/external-annotation-import`.
2. Introduce the provider-neutral types and managed-block formatter in `src/lib/annotation-import.ts`.
3. Add synthetic fixtures and a minimal test runner before moving Zotero rendering.
4. Implement Apple Preview first because `HighlightExtractor` and PDF.js loading already exist.
5. Implement `My Clippings.txt` next.
6. Ask for one user-exported Apple Books sample only after the generic text/HTML parser scaffold is ready; inspect structure without persisting personal contents.
7. Defer any private Apple Books database route until the export workflow is proven insufficient and explicit permission is obtained.

## Primary references

- Apple Books highlights and notes: https://support.apple.com/guide/books/highlight-and-add-notes-ibks3975f128/mac
- Apple Books sharing on iPhone: https://support.apple.com/en-au/guide/iphone/iph17bf340c1/ios
- Apple Preview PDF annotations and flattening behavior: https://support.apple.com/en-au/guide/preview/prvw11580/mac
- Kindle Scribe export behavior: https://www.amazon.com/gp/help/customer/display.html?nodeId=TJE2UYmdw0ppUuR3Rs
