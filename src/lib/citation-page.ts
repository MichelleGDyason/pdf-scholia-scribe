const ROMAN_NUMERALS: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
];

export function toLowerRoman(value: number): string | null {
    if (!Number.isSafeInteger(value) || value < 1) return null;

    let remainder = value;
    let result = '';
    for (const [amount, numeral] of ROMAN_NUMERALS) {
        while (remainder >= amount) {
            result += numeral;
            remainder -= amount;
        }
    }
    return result;
}

/**
 * Applies a printed-page offset without exposing zero or negative citation pages.
 * Pages before printed page 1 use the conventional lower-case Roman front-matter sequence.
 */
export function formatCitationPageWithOffset(rawPage: number, offset: number, fallbackLabel: string) {
    if (!Number.isFinite(rawPage) || !Number.isFinite(offset)) return fallbackLabel;

    const adjustedPage = rawPage + offset;
    if (adjustedPage > 0) return String(adjustedPage);

    return toLowerRoman(rawPage) ?? fallbackLabel;
}
