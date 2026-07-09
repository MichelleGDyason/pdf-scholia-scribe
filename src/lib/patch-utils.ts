/**
 * Utilities for forwarding methods wrapped by `monkey-around`.
 *
 * Monkey patches receive original methods as dynamic values, so TypeScript
 * cannot prove the original method's `this`, argument, or return types from the
 * library call alone. These helpers keep that unsafe boundary explicit and
 * small: patchers define a narrow local method shape, convert the dynamic value
 * once, and then forward it through `Reflect.apply`.
 *
 * `Reflect.apply` is preferred over `method.call(thisArg, ...args)` because it
 * avoids the unsafe `Function.call` member-access pattern flagged by the
 * TypeScript lint rules. `unknown[]` is used for open-ended argument lists so
 * callers can forward values without granting permission to inspect them as
 * `any`. This module is Obsidian-plugin infrastructure and does not describe a
 * PDF.js API.
 */

/**
 * Typed shape for a method being wrapped by `monkey-around`.
 *
 * Patchers should create local aliases from this type when they know the
 * Obsidian method's `this` value, argument tuple, and return type. The helper
 * intentionally uses an argument tuple rather than `any[]`; unknown or
 * open-ended forwarding should be represented as `unknown[]` so future code
 * must narrow before reading forwarded values. The limitation is that this
 * type documents an assumption about a private or semi-private method; it does
 * not validate that assumption at runtime.
 */
export type PatchedMethod<ThisArg, Args extends unknown[], Return> = (this: ThisArg, ...args: Args) => Return;

/**
 * Converts a dynamic original method from `monkey-around` into a local typed
 * patched-method shape.
 *
 * This helper exists to centralize the unavoidable cast from private Obsidian
 * runtime values into the local method contract. It is safer than repeated
 * call-site casts because each patcher can name and document the expected
 * method shape once, then reuse the converted value. It assumes the caller has
 * chosen a method shape matching the prototype being patched; no runtime
 * validation is attempted.
 */
export const asPatchedMethod = <ThisArg, Args extends unknown[], Return>(
    method: unknown
): PatchedMethod<ThisArg, Args, Return> => {
    return method as PatchedMethod<ThisArg, Args, Return>;
};

/**
 * Forwards a typed patched method with its original `this` value and argument
 * list.
 *
 * This wrapper exists to avoid the unsafe `old.call(this, ...args)` pattern
 * while preserving runtime behavior exactly: the same method, receiver, and
 * arguments are forwarded. The argument list must already match the local
 * `PatchedMethod` alias, which keeps the helper small and prevents it from
 * becoming a broad dynamic dispatcher.
 */
export const callPatchedMethod = <ThisArg, Args extends unknown[], Return>(
    method: PatchedMethod<ThisArg, Args, Return>,
    thisArg: ThisArg,
    args: Args
): Return => {
    return Reflect.apply(method, thisArg, args);
};
