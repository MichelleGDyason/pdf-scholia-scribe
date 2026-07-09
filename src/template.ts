import { App, FileView, getLinkpath, MarkdownView, parseYaml, TFile } from 'obsidian';
import * as obsidian from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusLib } from 'lib';

type CitationInfo = {
    author: string;
    authors: string[];
    year: string;
    number: string;
    page: string;
    pageLabel: string;
    title: string;
    hasAuthor: boolean;
    hasYear: boolean;
    hasNumber: boolean;
    harvard: string;
    apa: string;
    asa: string;
    numeric: string;
    numericPage: string;
    format: (style?: string) => string;
    inText: (style?: string) => string;
};

type TemplateVariables = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

function hasCustomToString(value: object): value is object & { toString: () => string } {
    const toString = (value as { toString?: unknown }).toString;
    return typeof toString === 'function' && toString !== Object.prototype.toString;
}

function stringifyScalar(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
    if (typeof value === 'symbol') return value.description ?? value.toString();
    if (typeof value === 'function') return value.name ? `[Function: ${value.name}]` : '[Function]';
    if (hasCustomToString(value)) {
        return value.toString();
    }
    return '[object Object]';
}

function stringifyTemplateValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map((item): string => stringifyTemplateValue(item)).join(', ');
    return stringifyScalar(value);
}

function splitTopLevel(expr: string, delimiter: string) {
    const parts: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < expr.length; i++) {
        const char = expr[i];
        if (quote) {
            if (char === '\\') i++;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') depth--;
        else if (char === delimiter && depth === 0) {
            parts.push(expr.slice(start, i).trim());
            start = i + 1;
        }
    }

    parts.push(expr.slice(start).trim());
    return parts;
}

function findTopLevelTernary(expr: string) {
    let depth = 0;
    let quote: '"' | "'" | null = null;
    let questionIndex = -1;
    let nestedQuestions = 0;

    for (let i = 0; i < expr.length; i++) {
        const char = expr[i];
        if (quote) {
            if (char === '\\') i++;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') depth--;
        else if (char === '?' && depth === 0) {
            if (questionIndex === -1) questionIndex = i;
            else nestedQuestions++;
        } else if (char === ':' && depth === 0 && questionIndex !== -1) {
            if (nestedQuestions > 0) {
                nestedQuestions--;
                continue;
            }
            return { questionIndex, colonIndex: i };
        }
    }

    return null;
}

function stripOuterParens(expr: string): string {
    let stripped = expr.trim();
    while (stripped.startsWith('(') && stripped.endsWith(')')) {
        let depth = 0;
        let quote: '"' | "'" | null = null;
        let wrapsWholeExpression = true;

        for (let i = 0; i < stripped.length; i++) {
            const char = stripped[i];
            if (quote) {
                if (char === '\\') i++;
                else if (char === quote) quote = null;
                continue;
            }
            if (char === '"' || char === "'") {
                quote = char;
                continue;
            }
            if (char === '(') depth++;
            else if (char === ')') {
                depth--;
                if (depth === 0 && i < stripped.length - 1) {
                    wrapsWholeExpression = false;
                    break;
                }
            }
        }

        if (!wrapsWholeExpression) break;
        stripped = stripped.slice(1, -1).trim();
    }
    return stripped;
}

function parseStringLiteral(expr: string) {
    const quote = expr[0];
    if ((quote !== '"' && quote !== "'") || expr[expr.length - 1] !== quote) return null;

    const raw = expr.slice(1, -1);
    return raw.replace(/\\(['"\\nrt])/g, (_, escaped: string) => {
        switch (escaped) {
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            default: return escaped;
        }
    });
}

function resolveTemplatePath(path: string, variables: TemplateVariables) {
    const parts = path.split('.');
    if (!parts.every((part) => IDENTIFIER_PATTERN.test(part))) {
        throw new Error(`Unsupported template expression: ${path}`);
    }

    let value: unknown = variables[parts[0]];
    for (const part of parts.slice(1)) {
        if (value === null || value === undefined) return undefined;
        value = (value as Record<string, unknown>)[part];
    }
    return value;
}

function isAllowedTemplateCall(path: string) {
    return /^(citation|cite)\.(format|inText)$/.test(path);
}

function isTemplateFunction(value: unknown): value is (...args: unknown[]) => unknown {
    return typeof value === 'function';
}

function evaluateTemplateExpression(expr: string, variables: TemplateVariables): unknown {
    expr = stripOuterParens(expr);
    if (!expr) return '';

    const ternary = findTopLevelTernary(expr);
    if (ternary) {
        const condition = expr.slice(0, ternary.questionIndex);
        const whenTrue = expr.slice(ternary.questionIndex + 1, ternary.colonIndex);
        const whenFalse = expr.slice(ternary.colonIndex + 1);
        return evaluateTemplateExpression(condition, variables)
            ? evaluateTemplateExpression(whenTrue, variables)
            : evaluateTemplateExpression(whenFalse, variables);
    }

    const concatParts = splitTopLevel(expr, '+');
    if (concatParts.length > 1) {
        return concatParts.map((part) => stringifyTemplateValue(evaluateTemplateExpression(part, variables))).join('');
    }

    const stringLiteral = parseStringLiteral(expr);
    if (stringLiteral !== null) return stringLiteral;
    if (/^-?\d+(?:\.\d+)?$/.test(expr)) return Number(expr);
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (expr === 'undefined') return undefined;

    const callMatch = expr.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\((.*)\)$/);
    if (callMatch) {
        const [, path, argSource] = callMatch;
        if (!isAllowedTemplateCall(path)) {
            throw new Error(`Unsupported template function: ${path}`);
        }
        const fn = resolveTemplatePath(path, variables);
        if (!isTemplateFunction(fn)) return '';
        const args = argSource.trim()
            ? splitTopLevel(argSource, ',').map((arg) => evaluateTemplateExpression(arg, variables))
            : [];
        return fn(...args);
    }

    return resolveTemplatePath(expr, variables);
}

const AUTHOR_KEYS = ['author', 'authors', 'creator', 'creators', 'by', 'writer', 'writers'];
const YEAR_KEYS = ['year', 'date', 'published', 'publicationDate', 'publication_date', 'publicationYear', 'publication_year', 'issued'];
const TITLE_KEYS = ['title', 'shortTitle', 'short_title', 'name'];
const NUMBER_KEYS = ['citationNumber', 'citation_number', 'referenceNumber', 'reference_number', 'bibliographyNumber', 'bibliography_number', 'number', 'index'];
const SHORT_CITATION_KEYS = ['shortCitation', 'short_citation', 'citation', 'cite', 'citekey', 'citeKey', 'citationKey', 'citation_key', 'inTextCitation', 'in_text_citation', 'referenceLabel', 'reference_label', 'aliases', 'alias'];
const PAGE_OFFSET_KEYS = ['citationPageOffset', 'citation_page_offset', 'pageOffset', 'page_offset', 'pdfPageOffset', 'pdf_page_offset', 'printedPageOffset', 'printed_page_offset', 'pageNumberOffset', 'page_number_offset'];
const FIRST_PRINTED_PAGE_KEYS = ['firstPrintedPage', 'first_printed_page', 'firstCitationPage', 'first_citation_page', 'printedPageStart', 'printed_page_start'];
const FIRST_PRINTED_PDF_PAGE_KEYS = ['firstPrintedPdfPage', 'first_printed_pdf_page', 'pdfPageForFirstPrintedPage', 'pdf_page_for_first_printed_page', 'pdfPageStart', 'pdf_page_start'];
const PAGE_ADJUSTMENT_KEYS = [...PAGE_OFFSET_KEYS, ...FIRST_PRINTED_PAGE_KEYS, ...FIRST_PRINTED_PDF_PAGE_KEYS];

function findProperty(properties: TemplateVariables, keys: string[]) {
    const normalizedKeys = keys.map((key) => key.toLowerCase());
    for (const [key, value] of Object.entries(properties)) {
        if (normalizedKeys.includes(key.toLowerCase())) return value;
    }
    return undefined;
}

function findPropertyInSources(sources: TemplateVariables[], keys: string[]) {
    for (const properties of sources) {
        const value = findProperty(properties, keys);
        if (value !== undefined) return value;
    }
    return undefined;
}

function flattenPropertyValue(value: unknown): string[] {
    if (value === null || value === undefined) return [];

    if (Array.isArray(value)) {
        return value.flatMap((item) => flattenPropertyValue(item));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.family === 'string' || typeof record.given === 'string') {
            return [`${stringifyTemplateValue(record.given)} ${stringifyTemplateValue(record.family)}`.trim()].filter(Boolean);
        }
        if (typeof record.display === 'string') return [record.display];
        if (typeof record.path === 'string') return [record.path];
        if (typeof record.name === 'string') return [record.name];
        return Object.values(record).flatMap((item) => flattenPropertyValue(item));
    }

    return [stringifyScalar(value)];
}

function stripLinkSyntax(value: string) {
    return value
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^["']|["']$/g, '')
        .trim();
}

function cleanCitationText(value: string) {
    const cleaned = stripLinkSyntax(value)
        .replace(/\.(md|pdf)$/i, '')
        .replace(/\s+PDF$/i, '')
        .replace(/.*\//, '')
        .trim();
    return cleaned;
}

function formatColorLabel(value: unknown) {
    if (value === null || value === undefined) return '';
    return stringifyScalar(value)
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitAuthorValue(value: string) {
    const cleaned = cleanCitationText(value);
    if (!cleaned) return [];
    return cleaned
        .split(/\s*(?:;|\s+and\s+|\s+&\s+)\s*/i)
        .map((part) => part.trim())
        .filter(Boolean);
}

function getFamilyName(name: string) {
    const cleaned = cleanCitationText(name);
    if (!cleaned) return '';
    if (cleaned.includes(',')) return cleaned.split(',')[0].trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    return parts[parts.length - 1] ?? cleaned;
}

function formatAuthorList(names: string[]) {
    const families = names
        .map((name) => getFamilyName(name))
        .filter(Boolean);
    if (families.length === 0) return '';
    if (families.length === 1) return families[0];
    if (families.length === 2) return `${families[0]} and ${families[1]}`;
    return `${families[0]} et al.`;
}

function firstCleanProperty(sources: TemplateVariables[], keys: string[]) {
    const values = flattenPropertyValue(findPropertyInSources(sources, keys))
        .map((value) => cleanCitationText(value))
        .filter(Boolean);
    return values[0] ?? '';
}

function extractYearFromText(value: string) {
    const match = value.match(/(?:18|19|20|21)\d{2}/);
    return match?.[0] ?? '';
}

function extractYear(sources: TemplateVariables[]) {
    const values = flattenPropertyValue(findPropertyInSources(sources, YEAR_KEYS));
    for (const value of values) {
        const year = extractYearFromText(value);
        if (year) return year;
    }
    return '';
}

function extractNumber(sources: TemplateVariables[]) {
    const values = flattenPropertyValue(findPropertyInSources(sources, NUMBER_KEYS));
    for (const value of values) {
        const match = value.match(/\d+/);
        if (match) return match[0];
    }
    return '';
}

function extractSignedInteger(value: string) {
    const match = value.match(/-?\d+/);
    return match ? Number(match[0]) : null;
}

function firstIntegerProperty(sources: TemplateVariables[], keys: string[]) {
    const values = flattenPropertyValue(findPropertyInSources(sources, keys));
    for (const value of values) {
        const integer = extractSignedInteger(value);
        if (integer !== null) return integer;
    }
    return null;
}

function pickProperties(properties: TemplateVariables, keys: string[]) {
    const normalizedKeys = keys.map((key) => key.toLowerCase());
    return Object.fromEntries(
        Object.entries(properties).filter(([key]) => normalizedKeys.includes(key.toLowerCase()))
    );
}

function removeYearFromText(value: string, year: string) {
    return year ? value.replace(year, '').trim() : value.trim();
}

function extractAuthorFromCitationText(value: string) {
    const cleaned = cleanCitationText(value)
        .replace(/[_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';

    const year = extractYearFromText(cleaned);
    if (year) {
        return cleaned.slice(0, cleaned.indexOf(year))
            .replace(/[-–—_:()[\]]+$/g, '')
            .trim();
    }

    const separatorMatch = cleaned.match(/^(.+?)\s+[-–—]\s+.+$/);
    const candidate = separatorMatch?.[1]?.trim() ?? '';
    const wordCount = candidate.split(/\s+/).filter(Boolean).length;
    return wordCount > 0 && wordCount <= 4 ? candidate : '';
}

function getCitationPage(sources: TemplateVariables[], pageLabel: string, rawPage: number) {
    const explicitOffset = firstIntegerProperty(sources, PAGE_OFFSET_KEYS);
    let offset = explicitOffset;

    if (offset === null) {
        const firstPrintedPage = firstIntegerProperty(sources, FIRST_PRINTED_PAGE_KEYS);
        const firstPrintedPdfPage = firstIntegerProperty(sources, FIRST_PRINTED_PDF_PAGE_KEYS);
        if (firstPrintedPage !== null && firstPrintedPdfPage !== null) {
            offset = firstPrintedPage - firstPrintedPdfPage;
        }
    }

    if (offset !== null && Number.isFinite(rawPage)) {
        return String(rawPage + offset);
    }

    return pageLabel;
}

function buildCitationInfo(sources: TemplateVariables[], file: TFile, pageLabel: string, rawPage: number): CitationInfo {
    const explicitShortCitation = firstCleanProperty(sources, SHORT_CITATION_KEYS);
    const fallbackCitationText = cleanCitationText(file.basename);
    const authors = flattenPropertyValue(findPropertyInSources(sources, AUTHOR_KEYS))
        .flatMap((value) => splitAuthorValue(value));
    const authorFromProperties = formatAuthorList(authors);
    const yearFromProperties = extractYear(sources);
    const yearFromShortCitation = extractYearFromText(explicitShortCitation || fallbackCitationText);
    const year = yearFromProperties || yearFromShortCitation || 'n.d.';
    const authorFromShortCitation = explicitShortCitation && yearFromShortCitation
        ? removeYearFromText(explicitShortCitation, yearFromShortCitation)
        : '';
    const authorFromFileName = extractAuthorFromCitationText(fallbackCitationText);
    const author = authorFromProperties || formatAuthorList(splitAuthorValue(authorFromShortCitation)) || formatAuthorList(splitAuthorValue(authorFromFileName)) || 'Unknown author';
    const numberFromProperties = extractNumber(sources);
    const number = numberFromProperties || '?';
    const title = firstCleanProperty(sources, TITLE_KEYS) || file.basename;
    const page = getCitationPage(sources, pageLabel, rawPage);
    const pagePart = page ? `p. ${page}` : '';
    const numeric = `[${number}]`;
    const numericPage = `[${number}${pagePart ? `, ${pagePart}` : ''}]`;

    const format = (style = 'harvard') => {
        const normalized = style.toLowerCase();
        if (normalized === 'apa') {
            return `(${author}, ${year}${pagePart ? `, ${pagePart}` : ''})`;
        }
        if (normalized === 'asa' || normalized === 'american sociological association') {
            return `(${author} ${year}${page ? `:${page}` : ''})`;
        }
        if (normalized === 'numeric' || normalized === 'numbered' || normalized === 'vancouver' || normalized === 'ieee') {
            return numericPage;
        }
        if (normalized === 'numeric-no-page' || normalized === 'numbered-no-page') {
            return numeric;
        }
        return `(${author} ${year}${pagePart ? `, ${pagePart}` : ''})`;
    };

    return {
        author,
        authors,
        year,
        number,
        page,
        pageLabel,
        title,
        hasAuthor: !!authorFromProperties,
        hasYear: !!yearFromProperties,
        hasNumber: !!numberFromProperties,
        harvard: format('harvard'),
        apa: format('apa'),
        asa: format('asa'),
        numeric,
        numericPage,
        format,
        inText: format,
    };
}


export class TemplateProcessor {
    constructor(public plugin: PDFPlus, public variables: TemplateVariables) { }

    setVariable(name: string, value: unknown) {
        this.variables[name] = value;
    }

    evalPart(expr: string) {
        return stringifyTemplateValue(evaluateTemplateExpression(expr, this.variables));
    }

    evalTemplate(template: string) {
        return template.replace(/{{(.*?)}}/g, (match, expr) => this.evalPart(expr));
    }
}

export class PDFPlusTemplateProcessor extends TemplateProcessor {
    app: App;
    lib: PDFPlusLib;

    constructor(plugin: PDFPlus, variables: {
        file: TFile,
        page: number,
        pageLabel: string,
        pageCount: number,
        text: string,
        [key: string]: unknown,
    }) {
        const { app } = plugin;

        // colorName is an alias for color
        if ('colorName' in variables) {
            variables.color = variables.colorName;
        }
        variables.colorLabel = formatColorLabel(variables.color);

        super(plugin, {
            ...variables,
            app,
            obsidian,
            pdf: variables.file,
            folder: variables.file.parent,
            selection: variables.text,
        });

        this.app = app;
        this.lib = plugin.lib;

        const md = this.findMarkdownFileAssociatedToPDF(variables.file);
        const properties = this.getFileProperties(md);
        this.setVariable('md', md);
        this.setVariable('properties', properties);

        const linkedFile = this.findLinkedFile(variables.file);
        const linkedFileProperties = this.getFileProperties(linkedFile);
        const targetFile = this.findTargetMarkdownFile(variables.file, linkedFile);
        const targetProperties = this.getFileProperties(targetFile);
        const pageAdjustmentProperties = this.findPageAdjustmentProperties(
            variables.file,
            [targetFile, linkedFile, md],
            [targetProperties, linkedFileProperties, properties]
        );
        const citationProperties = this.mergePropertiesForCitation(pageAdjustmentProperties, targetProperties, linkedFileProperties, properties);
        const citation = buildCitationInfo([targetProperties, linkedFileProperties, properties, pageAdjustmentProperties], variables.file, variables.pageLabel, variables.page);
        this.setVariable('citation', citation);
        this.setVariable('cite', citation);
        this.setVariable('author', citation.author);
        this.setVariable('authors', citation.authors);
        this.setVariable('year', citation.year);
        this.setVariable('citationNumber', citation.number);
        this.setVariable('referenceNumber', citation.number);
        this.setVariable('title', citation.title);
        this.setVariable('linkedFile', linkedFile);
        this.setVariable('linkedFileProperties', linkedFileProperties);
        this.setVariable('targetFile', targetFile);
        this.setVariable('targetProperties', targetProperties);
        this.setVariable('pageAdjustmentProperties', pageAdjustmentProperties);
        this.setVariable('citationProperties', citationProperties);

        // @ts-ignore
        const dv = app.plugins.plugins.dataview?.api;
        // @ts-ignore
        // const tp = app.plugins.plugins['templater-obsidian']?.templater.current_functions_object;
        // @ts-ignore
        const quickAddApi = app.plugins.plugins.quickadd?.api;
        if (dv) this.setVariable('dv', dv);
        // if (tp) this.setVariable('tp', tp);
        if (quickAddApi) this.setVariable('quickAddApi', quickAddApi);
    }

    getFileProperties(file: TFile | null) {
        if (!file) return {};
        const cachedProperties = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        const openViewProperties = this.getOpenMarkdownViewProperties(file);
        return { ...cachedProperties, ...openViewProperties };
    }

    getOpenMarkdownViewProperties(file: TFile) {
        let properties: TemplateVariables = {};
        this.app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || view.file !== file) return;

            const match = view.getViewData().match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
            if (!match) return;

            try {
                properties = parseYaml(match[1]) ?? {};
            } catch (err) {
                console.error(`${this.plugin.manifest.name}: Failed to parse open note frontmatter for citation metadata.`, err);
            }
        });
        return properties;
    }

    findPageAdjustmentProperties(pdf: TFile, sourceFiles: (TFile | null)[], sourceProperties: TemplateVariables[]) {
        const candidates = new Set<TFile>();
        const addCandidate = (file: TFile | null) => {
            if (file?.extension === 'md') candidates.add(file);
        };

        sourceFiles.forEach(addCandidate);
        this.findOpenMarkdownFiles().forEach(addCandidate);

        const backlinks = this.app.metadataCache.getBacklinksForFile(pdf);
        for (const sourcePath of backlinks.keys()) {
            const file = this.app.vault.getAbstractFileByPath(sourcePath);
            if (file instanceof TFile && file.extension === 'md') candidates.add(file);
        }

        const identity = this.getCitationIdentity(sourceProperties);

        for (const candidate of candidates) {
            const properties = this.getFileProperties(candidate);
            const adjustmentProperties = pickProperties(properties, PAGE_ADJUSTMENT_KEYS);
            if (!Object.keys(adjustmentProperties).length) continue;

            if (sourceFiles.includes(candidate)
                || this.propertiesPointToPDF(properties, pdf, candidate.path)
                || this.propertiesMatchCitationIdentity(properties, identity)) {
                return adjustmentProperties;
            }
        }

        return {};
    }

    getCitationIdentity(sourceProperties: TemplateVariables[]) {
        return {
            shortCitation: firstCleanProperty(sourceProperties, SHORT_CITATION_KEYS).toLowerCase(),
            title: firstCleanProperty(sourceProperties, TITLE_KEYS).toLowerCase(),
            year: extractYear(sourceProperties),
        };
    }

    propertiesMatchCitationIdentity(properties: TemplateVariables, identity: { shortCitation: string, title: string, year: string }) {
        const shortCitation = firstCleanProperty([properties], SHORT_CITATION_KEYS).toLowerCase();
        if (identity.shortCitation && shortCitation && identity.shortCitation === shortCitation) return true;

        const title = firstCleanProperty([properties], TITLE_KEYS).toLowerCase();
        const year = extractYear([properties]);
        return !!identity.title && !!title && identity.title === title && (!identity.year || !year || identity.year === year);
    }

    propertiesPointToPDF(properties: TemplateVariables, pdf: TFile, sourcePath: string) {
        const values = flattenPropertyValue(findProperty(properties, [this.plugin.settings.proxyMDProperty]));
        return values.some((value) => {
            const linkpath = getLinkpath(stripLinkSyntax(value));
            const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
            return targetFile?.path === pdf.path
                || linkpath === pdf.path
                || linkpath === pdf.name
                || linkpath === pdf.basename;
        });
    }

    findMarkdownFileAssociatedToPDF(pdf: TFile) {
        const app = this.plugin.app;
        let proxyMDs: TFile[] = [];

        // @ts-ignore
        const dv = app.plugins.plugins.dataview?.api;
        if (dv) {
            const proxyMDPages = dv.pages().where((page) => dv.array(page[this.plugin.settings.proxyMDProperty] ?? []).path.includes(pdf.path));
            proxyMDs = proxyMDPages.map((page) => app.vault.getAbstractFileByPath(page.file.path)).filter((file): file is TFile => file instanceof TFile);
        } else {
            const backlinks = app.metadataCache.getBacklinksForFile(pdf);
            for (const sourcePath of backlinks.keys()) {
                const cache = app.metadataCache.getCache(sourcePath);
                if (cache) {
                    const isProxyMD = cache.frontmatterLinks?.some((link) => {
                        if (link.key !== this.plugin.settings.proxyMDProperty
                            && !(new RegExp(`${this.plugin.settings.proxyMDProperty}.\\d+`).test(link.key))) {
                            return false;
                        }
                        const linkpath = getLinkpath(link.link);
                        const targetFile = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
                        return targetFile && targetFile.path === pdf.path;
                    });
                    if (isProxyMD) {
                        const proxyMD = app.vault.getAbstractFileByPath(sourcePath);
                        if (proxyMD instanceof TFile) proxyMDs.push(proxyMD);
                    }
                }
            }
        }

        if (proxyMDs.length > 1) {
            const msg = `Multiple markdown files are associated with this PDF file:\n${proxyMDs.map(file => '- ' + file.path).join('\n')}\nAborting.`;
            throw Error(msg);
        }

        return proxyMDs.first() ?? null;
    }

    findLinkedFile(pdf: TFile) {
        // find a file opened in a linked tab
        const groupLeaves = this.lib.workspace.getActiveGroupLeaves();
        if (groupLeaves) {
            for (const leaf of groupLeaves) {
                if (leaf.view instanceof FileView && leaf.view.file && leaf.view.file !== pdf && leaf.view.file.extension === 'md') {
                    return leaf.view.file;
                }
            }
        }
        return null;
    }

    findTargetMarkdownFile(pdf: TFile, linkedFile: TFile | null) {
        const lastActiveMarkdownFile = this.plugin.lastActiveMarkdownFile;
        const openMarkdownFiles = this.findOpenMarkdownFiles();

        if (lastActiveMarkdownFile && openMarkdownFiles.includes(lastActiveMarkdownFile)) {
            return lastActiveMarkdownFile;
        }

        if (linkedFile && linkedFile.extension === 'md') return linkedFile;

        if (openMarkdownFiles.length === 1) return openMarkdownFiles[0];

        if (lastActiveMarkdownFile && lastActiveMarkdownFile !== pdf && lastActiveMarkdownFile.extension === 'md') {
            return lastActiveMarkdownFile;
        }

        return linkedFile?.extension === 'md' ? linkedFile : null;
    }

    findOpenMarkdownFiles() {
        const files: TFile[] = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view;
            if (!(view instanceof FileView) || !(view.file instanceof TFile) || view.file.extension !== 'md') return;
            if (!files.includes(view.file)) files.push(view.file);
        });
        return files;
    }

    mergePropertiesForCitation(...sources: TemplateVariables[]) {
        return sources.reduceRight((merged, properties) => {
            return { ...merged, ...properties };
        }, {});
    }
}
