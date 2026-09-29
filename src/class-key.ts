import { TFunction } from './types'

const CLASS_KEYS = Symbol.for('prostojs:infact:class-keys')

/**
 * Kept on the global object so that every copy of @prostojs/infact in the
 * process (e.g. one per adapter package) keys a constructor identically — a
 * provide/replace registry built by one copy must match the lookups of
 * another. Resolved lazily: the package ships `"sideEffects": false`.
 */
let classKeys: WeakMap<object, symbol> | undefined

/**
 * The key a class constructor is filed under in every Infact registry:
 * provide and replace registries, singleton (instance, global and scope)
 * registries.
 *
 * The key is a unique `Symbol(className)` per constructor object: two
 * distinct classes are always distinct keys, even when their source text is
 * identical (`const A = class {}` and `const B = class {}`). It is computed
 * once per constructor, so the same constructor gets the same key everywhere.
 *
 * Use it wherever a class-keyed token has to match what Infact stores, e.g.
 * to normalize a class passed as a param `inject` token.
 */
export function getClassKey(classConstructor: TFunction): symbol {
    classKeys ??= (
        globalThis as unknown as Record<symbol, WeakMap<object, symbol>>
    )[CLASS_KEYS] ??= new WeakMap()
    let key = classKeys.get(classConstructor)
    if (!key) {
        key = Symbol(classConstructor.name)
        classKeys.set(classConstructor, key)
    }
    return key
}
