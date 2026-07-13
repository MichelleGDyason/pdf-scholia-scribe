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
 * Plugin-owned state forwarded from a PDF backlink highlight through Obsidian's `hover-link` event.
 *
 * The visualizer always emits a truthy trigger marker and adds `scroll` only when the Markdown
 * backlink cache contains a numeric source line. The marker remains `unknown` in this shared
 * boundary contract because the existing Page Preview branch intentionally accepts any truthy
 * marker. Obsidian does not publish a type for per-source hover state, so both the producer and the
 * Page Preview patcher must import this contract and review it if that private payload channel
 * changes. The state object is forwarded by identity and must not be cloned or normalized.
 */
export interface BacklinkVisualizerHoverState {
    isTriggeredFromBacklinkVisualizer: unknown;
    scroll?: number;
}

/**
 * Verify that unknown Page Preview state can open the Markdown source of a backlink highlight.
 *
 * The guard preserves the previous truthy-marker check and requires the optional source line to be
 * numeric. Missing or malformed state falls back to Obsidian's original Page Preview handler.
 * Property checks replace a broad cast and prevent unsafe member access without changing object
 * identity; property getters and proxy traps still retain their existing thrown-error behavior.
 */
export const isBacklinkVisualizerHoverState = (
    state: unknown
): state is BacklinkVisualizerHoverState & { scroll: number } => {
    if (typeof state !== 'object' || state === null) return false;
    return 'isTriggeredFromBacklinkVisualizer' in state
        && !!state.isTriggeredFromBacklinkVisualizer
        && 'scroll' in state
        && typeof state.scroll === 'number';
};

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
