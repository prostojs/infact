export const MODULE_IDENTITY_KEY = Symbol.for('prostojs:infact:module-identity')

export interface TInfactModuleIdentity {
    version?: string
    path?: string
}

function describeCopy(identity: TInfactModuleIdentity): string {
    return `${identity.version || 'unknown version'} at ${
        identity.path || 'unknown path'
    }`
}

/**
 * Stamps the global object with this module's identity and warns when
 * another copy of @prostojs/infact was already loaded — module-scoped
 * state (global singleton registry, instance caches) does not
 * interoperate between copies.
 *
 * Exported for testability; invoked once at module scope.
 */
export function stampModuleIdentity(
    identity: TInfactModuleIdentity,
    globalObject: object = globalThis,
): void {
    const holder = globalObject as Record<
        symbol,
        TInfactModuleIdentity | undefined
    >
    const existing = holder[MODULE_IDENTITY_KEY]
    if (existing) {
        console.warn(
            `[infact] A second copy of @prostojs/infact was loaded (${describeCopy(
                existing,
            )}, now ${describeCopy(
                identity,
            )}). DI singleton registries and instance caches will NOT interoperate between copies. Check your bundler/dedupe settings.`,
        )
    } else {
        holder[MODULE_IDENTITY_KEY] = identity
    }
}

let stamped = false

/**
 * One-shot wrapper around `stampModuleIdentity` for this module copy.
 *
 * Invoked at module scope AND from the `Infact` constructor: the package
 * ships `"sideEffects": false`, so a tree-shaking bundler may drop the
 * module-scope invocation when nothing imports from this file — the
 * constructor call keeps the duplicate check reachable in bundled apps,
 * which are exactly the environments that produce duplicate copies.
 */
export function stampOnce(): void {
    if (stamped) {
        return
    }
    stamped = true
    stampModuleIdentity({
        version: typeof __VERSION__ === 'string' ? __VERSION__ : undefined,
        // `typeof` is safe on the undeclared `__filename` in ESM;
        // in the CJS bundle it is defined and wins
        path: typeof __filename === 'string' ? __filename : import.meta.url,
    })
}

stampOnce()
