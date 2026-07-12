/**
   Copyright 2020 Colin Caine, Oliver Blanthorn and Koushien

   Tridactyl is licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

   ================================
   The file was taken from Tridactyl, which is licensed under the Apache License, Version 2.0:
   https://github.com/tridactyl/tridactyl?tab=License-1-ov-file
   Some parts were then modified.
 */

/**
 * Yields a finite set of primitive-string hint names in deterministic character order.
 *
 * For the supported alphabets of at least two unique characters, the generator skips
 * enough early combinations to keep the longest required names short, then rolls over
 * to the next name length after exhausting the current one. No mutable arrays escape.
 *
 * Taken from https://github.com/tridactyl/tridactyl/blob/4a4c9c7306b436611088b6ff2dceff77e7ccbfd6/src/content/hinting.ts#L602-L632
 */
export function* hintnames_short(
    n: number,
    hintchars: string,
): Generator<string, void, unknown> {
    const source = hintnames_simple(hintchars);
    const num2skip = Math.max(0, Math.ceil((n - hintchars.length) / (hintchars.length - 1)));
    yield* islice(source, num2skip, n + num2skip);
}

/**
 * Yields an unbounded stream of primitive-string hints for a nonempty alphabet.
 *
 * Names follow the supplied character order and increase in length only after every
 * permutation at the current length has been yielded. Each string is newly constructed
 * from a fresh permutation array, so no mutable working buffer is exposed.
 *
 * Taken from https://github.com/tridactyl/tridactyl/blob/4a4c9c7306b436611088b6ff2dceff77e7ccbfd6/src/content/hinting.ts#L587-L600
 */
function* hintnames_simple(
    hintchars: string,
): Generator<string, void, unknown> {
    for (let taglen = 1; true; taglen++) {
        yield* map(permutationsWithReplacement(hintchars, taglen), e =>
            e.join(''),
        );
    }
}

/**
 * Yields fixed-length permutations in base-index order using a mutable numeric counter.
 *
 * Every yielded `T[]` is newly allocated; only the internal `number[]` counter is reused.
 * Filling that counter with primitive zero values cannot create shared object references.
 * Array-like element references are copied unchanged into each result.
 *
 * @typeParam T - Element type read from the input array-like value and yielded in each permutation.
 * Taken from https://github.com/tridactyl/tridactyl/blob/4a4c9c7306b436611088b6ff2dceff77e7ccbfd6/src/lib/itertools.ts#L130-L144
 */
function* permutationsWithReplacement<T>(arr: ArrayLike<T>, n: number): Generator<T[], void, unknown> {
    const len = arr.length;
    const counters = Array<number>(n).fill(0);
    let index = 1;
    for (let count = 0; count < Math.pow(len, n); count++) {
        yield counters.map(i => arr[i]);
        for (const i of range(counters.length)) {
            if (knuth_mod(index, Math.pow(len, counters.length - 1 - i)) === 0) {
                counters[i] = knuth_mod(counters[i] + 1, len);
            }
        }
        index++;
    }
}

/**
 * Lazily yields a finite slice without changing source order or retaining yielded values.
 * The generator finishes early when its input is exhausted and otherwise stops at `stop`.
 *
 * @typeParam T - Value type forwarded unchanged from the source iterable.
 *
 * islice(iter, stop) = Give the first `stop` elements
 * islice(iter, start, stop)
 *     skip `start` elements, then give `stop - start` elements,
 *     unless `stop` is null, then emit indefinitely
 * 
 *  If the iterator runs out early so will this.
 * 
 *  Taken from https://github.com/tridactyl/tridactyl/blob/4a4c9c7306b436611088b6ff2dceff77e7ccbfd6/src/lib/itertools.ts#L89-L122 
 */
function* islice<T>(iterable: Iterable<T>, start: number, stop?: number): Generator<T, void, unknown> {
    const iter = iterable[Symbol.iterator]();

    // If stop is not defined then they're using the two argument variant
    if (stop === undefined) {
        stop = start;
        start = 0;
    }

    // Skip elements until start
    for (let skipped = 0; skipped < start; skipped++) {
        const res = iter.next();
        if (res.done) return;
    }

    // Emit elements
    for (let i = start; i < stop; i++) {
        const res = iter.next();
        if (res.done) return;
        else yield res.value;
    }
}

/**
 * Yields the finite integer sequence from zero up to, but excluding, `length`.
 * Each yielded number is a primitive index used to mutate the internal counter in order.
 *
 * Taken from https://github.com/tridactyl/tridactyl/blob/4a4c9c7306b436611088b6ff2dceff77e7ccbfd6/src/lib/itertools.ts#L44-L49
 */
function* range(length: number): Generator<number, void, unknown> {
    if (length < 0) return;
    for (let index = 0; index < length; index++) {
        yield index;
    }
}

/**
 * Lazily maps each input value to one output value while preserving order and exhaustion.
 * Results are yielded exactly as returned by `func`; this helper does not cache or reuse them.
 *
 * @typeParam T - Element type consumed from the source iterable.
 * @typeParam U - Element type produced by the mapping callback and yielded to the consumer.
 *
 * Taken from https://github.com/tridactyl/tridactyl/blob/4a4c9c7306b436611088b6ff2dceff77e7ccbfd6/src/lib/itertools.ts#L146-L148
 */
function* map<T, U>(arr: Iterable<T>, func: (v: T) => U): Generator<U, void, unknown> {
    for (const v of arr) yield func(v);
}

/** 
 * Takes sign of divisor -- incl. returning -0
 * 
 * Taken from https://github.com/tridactyl/tridactyl/blob/4a4c9c7306b436611088b6ff2dceff77e7ccbfd6/src/lib/number.mod.ts#L9-L12
 */
function knuth_mod(dividend: number, divisor: number) {
    return dividend - divisor * Math.floor(dividend / divisor);
}
