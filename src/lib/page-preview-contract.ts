import type { App } from 'obsidian';

/**
 * Private Obsidian Page Preview instance facet used by the hover patcher.
 *
 * Obsidian publicly exposes hover-source registration but not the built-in plugin instance or its
 * `onLinkHover` method. This neutral alias keeps the patcher and settings boundary anchored to the
 * same ambient private contract. Review it if Obsidian moves the instance or changes that method.
 */
export type PagePreviewInstance = App['internalPlugins']['plugins']['page-preview']['instance'];

/**
 * Settings facet stored directly on Obsidian's private Page Preview plugin instance.
 *
 * `overrides` maps hover-source IDs to persisted values owned by the core plugin. Values remain
 * `unknown` because this plugin must preserve the existing truthiness of unexpected non-null data.
 * Consumers should use `PDFPlus.requireModKeyForLinkHover()` so missing private state consistently
 * falls back to the source's public `defaultMod` value rather than reading this interface directly.
 */
export interface PagePreviewModifierSettings {
    readonly overrides: Readonly<Record<string, unknown>>;
}

/**
 * Verifies the private Page Preview instance has an indexable modifier-override object.
 *
 * The runtime check is required because core-plugin instances are outside Obsidian's public types
 * and can be absent while unavailable or during lifecycle transitions. Disabled instances with
 * valid settings remain accepted. The guard prevents unsafe member access and accidental
 * `TypeError`s; missing, null, or primitive override state is rejected so callers can use the public
 * hover-source fallback. Property getters still run normally and retain their existing errors.
 */
export const hasPagePreviewModifierSettings = (value: unknown): value is PagePreviewModifierSettings => {
    if (typeof value !== 'object' || value === null || !('overrides' in value)) return false;
    return typeof value.overrides === 'object' && value.overrides !== null;
};
