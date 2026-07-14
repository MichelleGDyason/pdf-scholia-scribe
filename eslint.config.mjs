import tsParser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig([
    {
        ignores: [
            "**/node_modules/**",
            "main.js",
            "dist/**",
            "coverage/**",
            "eslint.config.mjs",
            "esbuild.config.mjs",
            "version-bump.mjs",
        ],
    },
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.{ts,cts,mts,tsx}"],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: __dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-base-to-string": "warn",
            "@typescript-eslint/no-duplicate-type-constituents": "warn",
            "@typescript-eslint/no-unnecessary-type-assertion": "warn",
            "@typescript-eslint/no-unsafe-argument": "warn",
            "@typescript-eslint/no-unsafe-assignment": "warn",
            "@typescript-eslint/no-unsafe-call": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-return": "warn",
            "@typescript-eslint/restrict-template-expressions": "warn",
        },
    },
    {
        files: ["src/main.ts"],
        rules: {
            // These public template identifiers are rendered as code. Their camelCase spelling is syntax;
            // sentence-casing either token would misdocument valid templates and break copied examples.
            "obsidianmd/ui/sentence-case": ["warn", {
                enforceCamelCaseLower: true,
                ignoreRegex: ["^linkedFile$", "^linkedFileProperties$"],
            }],
        },
    },
    {
        files: ["src/modals/zotero-citation-modal.ts"],
        rules: {
            // This search placeholder is a citation example containing two proper surnames and a year.
            // Lowercasing either surname would make the example incorrect.
            "obsidianmd/ui/sentence-case": ["warn", {
                enforceCamelCaseLower: true,
                ignoreRegex: ["^Deleuze Nietzsche 1983$"],
            }],
        },
    },
    {
        files: ["src/settings.ts"],
        rules: {
            // These complete settings strings use standard technical acronyms that must remain uppercase.
            // Exact matches keep the exception from hiding unrelated sentence-case warnings in this file.
            "obsidianmd/ui/sentence-case": ["warn", {
                enforceCamelCaseLower: true,
                ignoreRegex: [
                    "^URI patterns for PDF files$",
                    "^Enter regular expressions that identify URIs for PDF files\\. When you drag a URI or URL from your browser into Obsidian's editor, these patterns check whether the destination is a PDF file\\. Enter each pattern on a separate line\\.$",
                    "^Zoom in / zoom out: when the active file is not PDF, run Font Size Adjuster's \"Increment font size\" / \"Decrement font size\" command$",
                    "^hlsearch$",
                    "^incsearch$",
                    "^Remove half-width whitespace between two Chinese/Japanese characters when copying text$",
                    "^Such whitespace can be introduced as a result of poor post-processing of OCR \\(optical character recognition\\)\\. Enable this option to remove it when copying links to text selections\\.$",
                    "^You can find more options in Style Settings > PDF Scholia Scribe\\.$",
                ],
            }],
        },
    },
]);
