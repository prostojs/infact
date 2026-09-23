import { stampOnce } from './module-identity'
import { TAny, TClassConstructor, TFunction, TObject } from './types'

const globalRegistry: Record<string | symbol, unknown> = {}

const symbolCache = new WeakMap<object, symbol>()
function classSymbol(c: object): symbol {
    let s = symbolCache.get(c)
    if (!s) {
        s = Symbol.for(c as unknown as string)
        symbolCache.set(c, s)
    }
    return s
}

type TRegistry = Record<string | symbol, unknown>
type TSyncContextFn<T extends TObject = TEmpty> = (
    classMeta?: T & TInfactClassMeta,
) => void | unknown

export interface TInfactGetOptions<T extends TObject = TAny> {
    customData?: T
    provide?: TProvideRegistry
    replace?: TReplaceRegistry
    hierarchy?: string[]
    fromScope?: string | symbol
    syncContextFn?: TSyncContextFn<TAny>
}

const UNDEFINED = Symbol('undefined')

const IMPORT_TYPE_HINT =
    ' Hint: the dependency\'s class may have been imported with "import type" (TypeScript erases it, emitting Object).'

function importTypeHint(type: unknown): string {
    return type === Object ? IMPORT_TYPE_HINT : ''
}

export class Infact<
    Class extends TObject = TEmpty,
    Prop extends TObject = TEmpty,
    Param extends TObject = TEmpty,
    Custom extends TObject = TAny,
> {
    protected registry: TRegistry = {}

    protected instanceRegistries: WeakMap<
        TObject,
        {
            provide: TProvideRegistry
            replace?: TReplaceRegistry
            customData?: Custom
        }
    > = new WeakMap()

    protected scopes = new Map<string | symbol, TRegistry>()

    /**
     * Per-container provide-factory resolution state, keyed by the provide
     * entry object. Entries usually live on shared (class-level) metadata,
     * so the memo must not be written onto them: it belongs to this
     * container and is reset by `_cleanup()`.
     */
    private provideMemo: TProvideMemo = new WeakMap()

    constructor(protected options: TInfactOptions<Class, Prop, Param, Custom>) {
        stampOnce()
    }

    /**
     * Cleanup function to reset registry
     *
     * It is usefull in dev mode when server restarts
     */
    public _cleanup() {
        this.registry = {}
        this.instanceRegistries = new WeakMap()
        this.scopes.clear()
        this.provideMemo = new WeakMap()
    }

    /**
     * Cleanup the global (cross-Infact) singleton registry.
     *
     * Use with care — affects every Infact instance sharing
     * global singletons.
     */
    public static _cleanupGlobal() {
        for (const key of Reflect.ownKeys(globalRegistry)) {
            delete globalRegistry[key]
        }
    }

    public raiseEvent(
        event: 'new-instance' | 'warn' | 'error',
        // eslint-disable-next-line @typescript-eslint/ban-types
        targetClass: Function,
        message: string,
        args?: unknown[],
        detail?: TInfactEventDetail,
    ) {
        if (this.options.on) {
            this.options.on(event, targetClass, message, args, detail)
        }
    }

    public registerScope(scopeId: string | symbol) {
        if (!this.scopes.has(scopeId)) {
            this.scopes.set(scopeId, {})
        }
    }

    public unregisterScope(scopeId: string | symbol) {
        this.scopes.delete(scopeId)
    }

    public getForInstance<IT extends TObject>(
        instance: TObject,
        classConstructor: TClassConstructor<IT>,
        opts?: TInfactGetOptions<Custom>,
    ): Promise<IT> {
        const registries = this.getInstanceRegistries(instance)
        return this.get(classConstructor, {
            ...opts,
            provide: registries.provide || {},
            replace: registries.replace,
            customData: registries.customData,
        })
    }

    public async get<IT extends TObject, O extends boolean>(
        classConstructor: TClassConstructor<IT>,
        opts?: TInfactGetOptions<Custom>,
        optional: O = false as O,
    ): Promise<IT> {
        const result = await this._get(classConstructor, opts, optional)
        if (result) {
            const { instance, mergedProvide, replace } = result
            if (this.options.storeProvideRegByInstance) {
                this.setInstanceRegistries(
                    instance as TObject,
                    mergedProvide,
                    replace,
                    opts?.customData,
                )
            }
            return instance
        }
        return undefined as unknown as IT
    }

    public setInstanceRegistries(
        instance: TObject,
        provide: TProvideRegistry,
        replace?: TReplaceRegistry,
        customData?: Custom,
    ) {
        this.instanceRegistries.set(instance, { provide, replace, customData })
    }

    public getInstanceRegistries(instance: TObject): {
        provide?: TProvideRegistry
        replace?: TReplaceRegistry
        customData?: Custom
    } {
        return this.instanceRegistries.get(instance) || {}
    }

    private async _get<IT extends TObject, O extends boolean>(
        classConstructor: TClassConstructor<IT>,
        opts?: TInfactGetOptions<Custom>,
        optional?: boolean,
    ): Promise<
        O extends true
            ?
                  | {
                        instance: IT
                        mergedProvide: TProvideRegistry
                        replace?: TReplaceRegistry
                    }
                  | undefined
            : {
                  instance: IT
                  mergedProvide: TProvideRegistry
                  replace?: TReplaceRegistry
              }
    > {
        const hierarchy = opts?.hierarchy || []
        const provide = opts?.provide
        const replace = opts?.replace
        const syncContextFn = opts?.syncContextFn
        hierarchy.push(classConstructor.name)
        let classMeta: (Class & TInfactClassMeta<Param>) | undefined
        let instanceKey = classSymbol(classConstructor)
        if (replace && replace[instanceKey]) {
            classConstructor = replace?.[instanceKey]
            instanceKey = classSymbol(classConstructor)
        }
        try {
            classMeta = this.options.describeClass(classConstructor)
        } catch (e) {
            throw this.panicOwnError(
                classConstructor,
                `An error occurred on "describeClass" function: ${(e as Error).message}`,
                hierarchy,
            )
        }
        if (!classMeta || !classMeta.injectable) {
            if (provide && provide[instanceKey]) {
                // allow to inject provided instances even if no @Injectable decorator called
                syncContextFn && syncContextFn(classMeta)
                return {
                    instance: await (getProvidedValue(
                        provide[instanceKey],
                        provide,
                        this.provideMemo,
                    ) as Promise<IT>),
                    mergedProvide: provide,
                    replace,
                }
            }
            if (!optional) {
                throw this.panicOwnError(
                    classConstructor,
                    `Class is not Injectable and not Optional.${importTypeHint(
                        classConstructor,
                    )}`,
                    hierarchy,
                )
            } else {
                return undefined as O extends true
                    ?
                          | {
                                instance: IT
                                mergedProvide: TProvideRegistry
                                replace: TReplaceRegistry
                            }
                          | undefined
                    : {
                          instance: IT
                          mergedProvide: TProvideRegistry
                          replace: TReplaceRegistry
                      }
            }
        }
        const scopeId = classMeta.scopeId || opts?.fromScope
        const supportGlobalRegistries = !opts?.fromScope
        if (scopeId && classMeta.global) {
            throw this.panicOwnError(
                classConstructor,
                `The scoped Injectable is not supported for Global scope. (${scopeId as string})`,
                hierarchy,
            )
        }
        if (scopeId && !this.scopes.has(scopeId)) {
            throw this.panicOwnError(
                classConstructor,
                `The requested scope "${scopeId as string}" isn't registered.`,
                hierarchy,
            )
        }
        const scope = scopeId ? this.scopes.get(scopeId)! : ({} as TRegistry)
        const classProvide = classMeta.provide
        const mergedProvide = classProvide
            ? { ...(provide || {}), ...classProvide }
            : provide || {}
        if (mergedProvide[instanceKey]) {
            syncContextFn && syncContextFn(classMeta)
            return {
                instance: await (getProvidedValue(
                    mergedProvide[instanceKey],
                    mergedProvide,
                    this.provideMemo,
                ) as Promise<IT>),
                mergedProvide,
                replace,
            }
        }
        if (
            !(supportGlobalRegistries && this.registry[instanceKey]) &&
            !(supportGlobalRegistries && globalRegistry[instanceKey]) &&
            !scope[instanceKey]
        ) {
            const registry = scopeId
                ? scope
                : classMeta.global
                  ? globalRegistry
                  : this.registry
            const params = classMeta.constructorParams || []
            const isCircular = !!params.some((p) => !!p.circular)
            let resolveCreation: ((v: unknown) => void) | undefined
            let rejectCreation: ((e: unknown) => void) | undefined
            if (isCircular) {
                registry[instanceKey] = Object.create(
                    classConstructor.prototype,
                ) // empty "instance"
            } else {
                const promise = new Promise((resolve, reject) => {
                    resolveCreation = resolve
                    rejectCreation = reject
                })
                promise.catch(() => {}) // prevent unhandled rejection when no concurrent awaiter
                registry[instanceKey] = promise
            }

            try {
                // Resolving Params
                const resolvedParams = []
                for (let i = 0; i < params.length; i++) {
                    const param = params[i]
                    if (param.inject) {
                        if (mergedProvide && mergedProvide[param.inject]) {
                            resolvedParams[i] = getProvidedValue(
                                mergedProvide[param.inject],
                                mergedProvide,
                                this.provideMemo,
                            )
                        } else if (param.nullable || param.optional) {
                            resolvedParams[i] = UNDEFINED
                        } else {
                            /* istanbul ignore next line */
                            throw this.panicOwnError(
                                classConstructor,
                                `Could not inject ${JSON.stringify(
                                    param.inject,
                                )} argument ${
                                    param.label
                                        ? `labeled as "${param.label}"`
                                        : `with index ${i}`
                                }`,
                                hierarchy,
                                {
                                    injectToken: param.inject,
                                    paramIndex: i,
                                    paramLabel: param.label,
                                },
                            )
                        }
                    } else if (this.options.resolveParam) {
                        resolvedParams[i] = this.options.resolveParam({
                            classMeta,
                            classConstructor,
                            index: i,
                            scopeId,
                            paramMeta: param,
                            customData: opts?.customData,
                            instantiate: (c) => {
                                return this.get(c, {
                                    customData: opts?.customData,
                                    fromScope: opts?.fromScope,
                                    syncContextFn,
                                    hierarchy,
                                    provide,
                                    replace,
                                })
                            },
                        })
                    }
                }

                for (let i = 0; i < resolvedParams.length; i++) {
                    const rp: unknown = resolvedParams[i]
                    if (isThenable(rp)) {
                        try {
                            syncContextFn && syncContextFn(classMeta)
                            resolvedParams[i] = await rp
                        } catch (e) {
                            throw this.panicParamException(
                                classConstructor,
                                e as Error,
                                params[i],
                                i,
                                hierarchy,
                            )
                        }
                    }
                }

                for (let i = 0; i < params.length; i++) {
                    const param = params[i]
                    if (typeof resolvedParams[i] === 'undefined') {
                        if (param.type === undefined && !param.circular) {
                            this.raiseEvent(
                                'warn',
                                classConstructor,
                                `constructor() expects argument ${
                                    param.label
                                        ? `labeled as "${param.label}"`
                                        : `#${i}`
                                } that is undefined. This might happen when Circular Dependency occurs. To handle Circular Dependencies please specify circular meta for param.`,
                            )
                        } else if (param.type === undefined && param.circular) {
                            param.type = (
                                param.circular as TFunction
                            )() as TFunction
                        }
                        if (typeof param.type === 'function') {
                            if (
                                [String, Number, Date, Array].includes(
                                    param.type as TAny,
                                )
                            ) {
                                if (!param.nullable && !param.optional) {
                                    throw this.panicOwnError(
                                        classConstructor,
                                        `Could not inject "${
                                            (param.type as unknown as TFunction)
                                                .name
                                        }" argument at index ${i}${
                                            param.label
                                                ? ` (${param.label})`
                                                : ''
                                        }. The param was not resolved to a value.`,
                                        hierarchy,
                                    )
                                }
                            }
                            resolvedParams[i] = this.get(
                                param.type as TClassConstructor<IT>,
                                {
                                    provide: param.provide
                                        ? { ...mergedProvide, ...param.provide }
                                        : mergedProvide,
                                    replace,
                                    hierarchy,
                                    syncContextFn,
                                    fromScope: param.fromScope,
                                    customData: opts?.customData,
                                },
                                param.optional || param.nullable,
                            )
                        }
                    }
                    if (resolvedParams[i] === UNDEFINED) {
                        resolvedParams[i] = undefined
                    }
                }

                for (let i = 0; i < resolvedParams.length; i++) {
                    const rp: unknown = resolvedParams[i]
                    if (isThenable(rp)) {
                        try {
                            syncContextFn && syncContextFn(classMeta)
                            resolvedParams[i] = await (rp as Promise<unknown>)
                        } catch (e) {
                            throw this.panicParamException(
                                classConstructor,
                                e as Error,
                                params[i],
                                i,
                                hierarchy,
                            )
                        }
                    }
                }

                const instance = new classConstructor(...(resolvedParams as []))
                if (isCircular) {
                    Object.defineProperties(
                        registry[instanceKey] as TObject,
                        Object.getOwnPropertyDescriptors(instance),
                    )
                }

                // Resolving Props
                if (
                    this.options.describeProp &&
                    this.options.resolveProp &&
                    classMeta.properties &&
                    classMeta.properties.length
                ) {
                    const resolvedProps: Record<
                        string | symbol,
                        Promise<unknown> | unknown
                    > = {}
                    for (const prop of classMeta.properties) {
                        const initialValue = (
                            instance as Record<string | symbol, unknown>
                        )[prop]
                        let propMeta: Prop | undefined
                        try {
                            propMeta = this.options.describeProp(
                                classConstructor,
                                prop,
                            )
                        } catch (e) {
                            throw this.panic(
                                classConstructor,
                                e as Error,
                                `Could not process prop "${prop as string}". An error occurred on "describeProp" function.\n${
                                    (e as Error).message
                                }`,
                                hierarchy,
                            )
                        }
                        if (propMeta) {
                            try {
                                resolvedProps[prop] = this.options.resolveProp({
                                    classMeta,
                                    classConstructor,
                                    initialValue,
                                    key: prop,
                                    scopeId,
                                    instance,
                                    propMeta,
                                    customData: opts?.customData,
                                    instantiate: (c) => {
                                        return this.get(c, {
                                            customData: opts?.customData,
                                            fromScope: opts?.fromScope,
                                            syncContextFn,
                                            hierarchy,
                                            provide,
                                            replace,
                                        })
                                    },
                                })
                            } catch (e) {
                                throw this.panic(
                                    classConstructor,
                                    e as Error,
                                    `Could not inject prop "${
                                        prop as string
                                    }". An exception occurred: ` +
                                        (e as Error).message,
                                    hierarchy,
                                )
                            }
                        }
                    }
                    for (const [prop, value] of Object.entries(resolvedProps)) {
                        try {
                            syncContextFn && syncContextFn(classMeta)
                            resolvedProps[prop] = value
                                ? await (value as Promise<unknown>)
                                : value
                        } catch (e) {
                            throw this.panic(
                                classConstructor,
                                e as Error,
                                `Could not inject prop "${prop}". ` +
                                    'An exception occurred: ' +
                                    (e as Error).message,
                                hierarchy,
                            )
                        }
                    }
                    Object.assign(instance as TObject, resolvedProps)
                }

                this.raiseEvent(
                    'new-instance',
                    classConstructor,
                    '',
                    resolvedParams,
                )
                if (!isCircular) {
                    registry[instanceKey] = instance
                }
                resolveCreation?.(instance)
            } catch (e) {
                if (rejectCreation) {
                    delete registry[instanceKey]
                    rejectCreation(e)
                }
                throw e
            }
        }
        hierarchy.pop()
        syncContextFn && syncContextFn(classMeta)
        const resolved =
            scope[instanceKey] ||
            this.registry[instanceKey] ||
            globalRegistry[instanceKey]
        return {
            instance: isThenable(resolved)
                ? await (resolved as Promise<IT>)
                : (resolved as IT),
            mergedProvide,
            replace,
        }
    }

    protected panic(
        // eslint-disable-next-line @typescript-eslint/ban-types
        targetClass: Function,
        origError: Error,
        text: string,
        hierarchy?: string[],
        detail?: TInfactEventDetail,
    ) {
        if (hierarchy) {
            // snapshot here — the live array is mutated on unwind
            detail = { ...detail, hierarchy: [...hierarchy] }
        }
        this.raiseEvent('error', targetClass, text, hierarchy, detail)
        return origError
    }

    protected panicOwnError(
        // eslint-disable-next-line @typescript-eslint/ban-types
        targetClass: Function,
        text: string,
        hierarchy?: string[],
        detail?: TInfactEventDetail,
    ) {
        const e = new Error(text)
        return this.panic(targetClass, e, text, hierarchy, detail)
    }

    private panicParamException(
        // eslint-disable-next-line @typescript-eslint/ban-types
        classConstructor: Function,
        error: Error,
        param: TInfactConstructorParamMeta,
        index: number,
        hierarchy: string[],
    ) {
        // a token-injected param (`inject`) has no `type` — name the token
        const typeName = param.type?.name
        const name =
            param.inject === undefined
                ? String(typeName)
                : provideTokenName(param.inject)
        return this.panic(
            classConstructor,
            error,
            `Could not inject "${name}" argument at index ${index}${
                param.label ? ` (${param.label})` : ''
            }. An exception occurred.${importTypeHint(param.type)}`,
            hierarchy,
            {
                injectToken: param.inject,
                paramIndex: index,
                paramLabel: param.label,
                paramTypeName: typeName,
            },
        )
    }
}

interface TProvideResolutionFrame {
    key: string | symbol
    token: string | symbol | TClassConstructor<TAny>
}

function provideTokenName(
    token: string | symbol | TClassConstructor<TAny>,
): string {
    if (typeof token === 'function') {
        return token.name || '[anonymous class]'
    }
    return typeof token === 'symbol'
        ? token.description || token.toString()
        : token
}

function circularProvideError(chain: TProvideResolutionFrame[]) {
    return new Error(
        `Circular provide-factory resolution detected: ${chain
            .map((frame) => provideTokenName(frame.token))
            .join(' → ')}`,
    )
}

/** Memo value of a provide entry whose factory is running (cycle detection). */
const RESOLVING = Symbol('resolving')

/**
 * A provide entry present in the memo has been entered by the container:
 * it is either in-flight (`RESOLVING`) or holds the factory's result. A
 * factory that throws, or returns a promise that rejects, is removed so the
 * next resolution retries it.
 */
type TProvideMemo = WeakMap<TProvideMeta, unknown>

function createProvideResolver(
    registry: TProvideRegistry,
    memo: TProvideMemo,
    stack: TProvideResolutionFrame[],
): TProvideResolver {
    return (token) => {
        const frame: TProvideResolutionFrame = {
            key: typeof token === 'function' ? classSymbol(token) : token,
            token,
        }
        const cycleStart = stack.findIndex((f) => f.key === frame.key)
        if (cycleStart >= 0) {
            throw circularProvideError([...stack.slice(cycleStart), frame])
        }
        const meta = registry[frame.key]
        if (!meta) {
            throw new Error(
                `Provide factory could not resolve token "${provideTokenName(
                    token,
                )}": token is not in the provide registry.`,
            )
        }
        if (memo.get(meta) === RESOLVING) {
            // the cycle closes through a token whose factory was entered
            // outside of the resolver chain (the top-level provided token),
            // so it is not on the stack — prepend it to show the loop
            throw circularProvideError([frame, ...stack, frame])
        }
        return getProvidedValue(meta, registry, memo, [...stack, frame])
    }
}

function getProvidedValue(
    meta: TProvideMeta,
    registry: TProvideRegistry,
    memo: TProvideMemo,
    stack?: TProvideResolutionFrame[],
) {
    if (memo.has(meta)) {
        const memoized = memo.get(meta)
        // re-entered while in flight outside the resolver chain
        return memoized === RESOLVING ? undefined : memoized
    }
    memo.set(meta, RESOLVING)
    let value: unknown
    try {
        value = meta.fn(createProvideResolver(registry, memo, stack ?? []))
    } catch (e) {
        // do not memoize a failed factory: the next resolution retries
        memo.delete(meta)
        throw e
    }
    memo.set(meta, value)
    if (isThenable(value)) {
        // nor one whose promise rejects — unless a `_cleanup()` or a retry
        // already replaced the entry
        value.then(undefined, () => {
            if (memo.get(meta) === value) memo.delete(meta)
        })
    }
    return value
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
    return !!v && typeof (v as PromiseLike<unknown>).then === 'function'
}

export function createProvideRegistry(
    ...args: [TClassConstructor<TAny> | string, TProvideFn][]
): TProvideRegistry {
    const provide: TProvideRegistry = {}
    for (const a of args) {
        const [type, fn] = a
        const key = typeof type === 'string' ? type : classSymbol(type)
        provide[key] = { fn }
    }
    return provide
}
export function createReplaceRegistry(
    ...args: [TClassConstructor<TAny>, TClassConstructor<TAny>][]
): TReplaceRegistry {
    const replace: TReplaceRegistry = {}
    for (const a of args) {
        const [type, newType] = a
        const key = classSymbol(type)
        replace[key] = newType
    }
    return replace
}

interface TEmpty {}

export interface TInfactOptions<
    Class extends TObject = TEmpty,
    Prop extends TObject = TEmpty,
    Param extends TObject = TEmpty,
    Custom extends TObject = TAny,
> {
    describeClass: (
        classConstructor: TClassConstructor<TAny>,
    ) => TInfactClassMeta<Param> & Class
    describeProp?: (
        classConstructor: TClassConstructor<TAny>,
        key: string | symbol,
    ) => Prop & {
        provide?: TProvideRegistry
    }
    resolveParam?: (opts: {
        paramMeta: TInfactClassMeta<Param>['constructorParams'][0]
        classMeta: TInfactClassMeta<Param> & Class
        classConstructor: TFunction
        scopeId?: string | symbol
        index: number
        customData?: Custom
        instantiate: <IT extends TObject>(
            c: TClassConstructor<IT>,
        ) => Promise<IT>
    }) => unknown | Promise<unknown>
    resolveProp?: (opts: {
        instance: TObject
        key: string | symbol
        initialValue: unknown
        propMeta: Prop
        scopeId?: string | symbol
        classMeta: TInfactClassMeta<Param> & Class
        classConstructor: TFunction
        customData?: Custom
        instantiate: <IT extends TObject>(
            c: TClassConstructor<IT>,
        ) => Promise<IT>
    }) => unknown | Promise<unknown>
    storeProvideRegByInstance?: boolean
    // eslint-disable-next-line @typescript-eslint/ban-types
    on?: (
        event: 'new-instance' | 'warn' | 'error',
        // eslint-disable-next-line @typescript-eslint/ban-types
        targetClass: Function,
        message: string,
        args?: unknown[],
        detail?: TInfactEventDetail,
    ) => void
}

export interface TInfactEventDetail {
    paramIndex?: number
    paramLabel?: string
    paramTypeName?: string
    injectToken?: string | symbol
    hierarchy?: string[]
}

export interface TInfactClassMeta<Param extends TObject = TEmpty> {
    injectable: boolean
    global?: boolean
    provide?: TProvideRegistry
    scopeId?: string | symbol
    properties?: (string | symbol)[]
    constructorParams: (Param & TInfactConstructorParamMeta)[]
}

export interface TInfactConstructorParamMeta {
    label?: string
    circular?: () => TClassConstructor<TAny>
    type?: TFunction
    inject?: string | symbol
    nullable?: boolean
    fromScope?: string | symbol
    provide?: TProvideRegistry
    optional?: boolean // same as nullable for compatibility
}

interface TProvideMeta {
    fn: TProvideFn
    /** @deprecated unused — resolution state is kept per container */
    resolved?: boolean
    /** @deprecated unused — resolution state is kept per container */
    value?: unknown
    /** @deprecated unused — resolution state is kept per container */
    resolving?: boolean
}

export type TProvideRegistry = Record<string | symbol, TProvideMeta>
export type TReplaceRegistry = Record<symbol, TClassConstructor<TAny>>

/**
 * Resolver passed into provide factories.
 *
 * Accepts a class constructor, a string or a symbol token and returns the
 * value produced by that token's provide factory within the same provide
 * registry (factories may chain). The value is returned as-is: if the
 * target factory returns a Promise, the resolver returns that Promise —
 * no awaiting happens inside — so `await` it in your factory if you need
 * the settled value.
 *
 * Throws if the token is not present in the provide registry or if a
 * circular provide-factory resolution is detected.
 */
export type TProvideResolver = (
    token: string | symbol | TClassConstructor<TAny>,
) => unknown

export type TProvideFn = (resolve?: TProvideResolver) => TAny
