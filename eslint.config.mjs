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
]);
