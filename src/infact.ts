import { getClassKey } from './class-key'
import { stampOnce } from './module-identity'
import { TAny, TClassConstructor, TFunction, TObject } from './types'

const globalRegistry: Record<string | symbol, unknown> = {}

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

    public get<IT extends TObject, O extends boolean>(
        classConstructor: TClassConstructor<IT>,
        opts?: TInfactGetOptions<Custom>,
        optional: O = false as O,
    ): Promise<IT> {
        try {
            // a native Promise passes through as is; a value (thenable
            // instances included) is adopted exactly as an async return
            return Promise.resolve(
                this._resolve(classConstructor, opts, optional) as IT,
            )
        } catch (e) {
            return Promise.reject(e)
        }
    }

    public setInstanceRegistries(
        instance: TObject,
        provide: TProvideRegistry,
        replace?: TReplaceRegistry,
        customData?: Custom,
    ) {
        // `get()` re-stamps on every resolution (cache hits included):
        // skip the write when the stamp already holds these exact refs
        const stamp = this.instanceRegistries.get(instance)
        if (
            stamp &&
            stamp.provide === provide &&
            stamp.replace === replace &&
            stamp.customData === customData
        ) {
            return
        }
        this.instanceRegistries.set(instance, { provide, replace, customData })
    }

    public getInstanceRegistries(instance: TObject): {
        provide?: TProvideRegistry
        replace?: TReplaceRegistry
        customData?: Custom
    } {
        return this.instanceRegistries.get(instance) || {}
    }

    /**
     * `get()` without the Promise wrapper: returns the instance synchronously
     * when every resolution step is synchronous, a Promise otherwise. May
     * throw synchronously.
     */
    private _resolve<IT extends TObject>(
        classConstructor: TClassConstructor<IT>,
        opts: TInfactGetOptions<Custom> | undefined,
        optional: boolean,
    ): IT | undefined | Promise<IT | undefined> {
        const result = this._get(classConstructor, opts, optional)
        return isThenable(result)
            ? result.then((r) => this._stamp(r, opts))
            : this._stamp(result, opts)
    }

    /** A nested dependency resolution: like `get()`, but sync-first. */
    private _resolveDep<IT extends TObject>(
        classConstructor: TClassConstructor<IT>,
        opts: TInfactGetOptions<Custom>,
        optional: boolean,
    ): IT | undefined | Promise<IT | undefined> {
        try {
            return this._resolve(classConstructor, opts, optional)
        } catch (e) {
            return Promise.reject(e)
        }
    }

    private _stamp<IT extends TObject>(
        result: TGetResult<IT> | undefined,
        opts: TInfactGetOptions<Custom> | undefined,
    ): IT | undefined {
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
        return undefined
    }

    /**
     * Resolves a class. Stays synchronous while every step is synchronous
     * (cached instances, sync provide factories, sync `resolveParam` /
     * `resolveProp`); the first pending Promise switches the rest of the
     * resolution to async.
     */
    private _get<IT extends TObject>(
        classConstructor: TClassConstructor<IT>,
        opts?: TInfactGetOptions<Custom>,
        optional?: boolean,
    ): TMaybePromise<TGetResult<IT> | undefined> {
        const hierarchy = opts?.hierarchy || []
        const provide = opts?.provide
        const replace = opts?.replace
        const syncContextFn = opts?.syncContextFn
        hierarchy.push(classConstructor.name)
        let classMeta: (Class & TInfactClassMeta<Param>) | undefined
        let instanceKey = getClassKey(classConstructor)
        if (replace && replace[instanceKey]) {
            classConstructor = replace?.[instanceKey]
            instanceKey = getClassKey(classConstructor)
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
                return getResult(
                    getProvidedValue(
                        provide[instanceKey],
                        provide,
                        this.provideMemo,
                    ),
                    provide,
                    replace,
                )
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
                return undefined
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
        // read-only when unscoped: `registry` below is only `scope` when scoped
        const scope = scopeId ? this.scopes.get(scopeId)! : NO_SCOPE
        const classProvide = classMeta.provide
        const mergedProvide = classProvide
            ? { ...(provide || {}), ...classProvide }
            : provide || {}
        if (mergedProvide[instanceKey]) {
            syncContextFn && syncContextFn(classMeta)
            return getResult(
                getProvidedValue(
                    mergedProvide[instanceKey],
                    mergedProvide,
                    this.provideMemo,
                ),
                mergedProvide,
                replace,
            )
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
            const created = runSyncFirst(
                this._create(
                    classConstructor,
                    classMeta,
                    opts,
                    mergedProvide,
                    registry,
                    instanceKey,
                    scopeId,
                    hierarchy,
                ),
            )
            if (isThenable(created)) {
                // the creation suspended: from now on concurrent resolutions
                // (and registry readers) see a real Promise placeholder
                const placeholder = registry[instanceKey]
                if (placeholder instanceof PendingCreation) {
                    registry[instanceKey] = placeholder.promise()
                }
                return created.then(() =>
                    this._finish<IT>(
                        hierarchy,
                        syncContextFn,
                        classMeta,
                        scope,
                        instanceKey,
                        mergedProvide,
                        replace,
                    ),
                )
            }
        }
        return this._finish<IT>(
            hierarchy,
            syncContextFn,
            classMeta,
            scope,
            instanceKey,
            mergedProvide,
            replace,
        )
    }

    private _finish<IT extends TObject>(
        hierarchy: string[],
        syncContextFn: TSyncContextFn<TAny> | undefined,
        classMeta: Class & TInfactClassMeta<Param>,
        scope: TRegistry,
        instanceKey: symbol,
        mergedProvide: TProvideRegistry,
        replace: TReplaceRegistry | undefined,
    ): TMaybePromise<TGetResult<IT>> {
        hierarchy.pop()
        syncContextFn && syncContextFn(classMeta)
        return getResult<IT>(
            scope[instanceKey] ||
                this.registry[instanceKey] ||
                globalRegistry[instanceKey],
            mergedProvide,
            replace,
        )
    }

    /**
     * Creates an instance and files it under `registry[instanceKey]`.
     * Written as a generator run by `runSyncFirst`: every `yield` is an
     * `await` that only suspends when the yielded value is a thenable.
     */
    private *_create<IT extends TObject>(
        classConstructor: TClassConstructor<IT>,
        classMeta: Class & TInfactClassMeta<Param>,
        opts: TInfactGetOptions<Custom> | undefined,
        mergedProvide: TProvideRegistry,
        registry: TRegistry,
        instanceKey: symbol,
        scopeId: string | symbol | undefined,
        hierarchy: string[],
    ): Generator<unknown, void, unknown> {
        const provide = opts?.provide
        const replace = opts?.replace
        const syncContextFn = opts?.syncContextFn
        const params = classMeta.constructorParams || []
        let isCircular = false
        for (let i = 0; i < params.length; i++) {
            if (params[i].circular) {
                isCircular = true
                break
            }
        }
        let pending: PendingCreation | undefined
        if (isCircular) {
            registry[instanceKey] = Object.create(classConstructor.prototype) // empty "instance"
        } else {
            pending = new PendingCreation()
            registry[instanceKey] = pending
        }
        // shared by every resolveParam/resolveProp call of this creation
        let instantiate:
            | (<T extends TObject>(c: TClassConstructor<T>) => Promise<T>)
            | undefined
        const getInstantiate = () =>
            (instantiate ??= (c) =>
                this.get(c, {
                    customData: opts?.customData,
                    fromScope: opts?.fromScope,
                    syncContextFn,
                    hierarchy,
                    provide,
                    replace,
                }))

        // Resolving Params
        const resolvedParams: unknown[] = []
        let resolvedProps:
            | Record<string | symbol, Promise<unknown> | unknown>
            | undefined
        try {
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
                        instantiate: getInstantiate(),
                    })
                }
            }

            for (let i = 0; i < resolvedParams.length; i++) {
                const rp: unknown = resolvedParams[i]
                if (isThenable(rp)) {
                    try {
                        syncContextFn && syncContextFn(classMeta)
                        resolvedParams[i] = yield rp
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

            // params resolved through a nested `get`: the parent's context is
            // restored after each of them (also when it completed synchronously)
            let viaGet: boolean[] | undefined
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
                                        param.label ? ` (${param.label})` : ''
                                    }. The param was not resolved to a value.`,
                                    hierarchy,
                                )
                            }
                        }
                        ;(viaGet ??= [])[i] = true
                        resolvedParams[i] = this._resolveDep(
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
                            !!(param.optional || param.nullable),
                        )
                    }
                }
                if (resolvedParams[i] === UNDEFINED) {
                    resolvedParams[i] = undefined
                }
            }

            for (let i = 0; i < resolvedParams.length; i++) {
                const rp: unknown = resolvedParams[i]
                if (isThenable(rp) || viaGet?.[i]) {
                    try {
                        syncContextFn && syncContextFn(classMeta)
                        resolvedParams[i] = isThenable(rp) ? yield rp : rp
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
                resolvedProps = {}
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
                                instantiate: getInstantiate(),
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
                        resolvedProps[prop] = isThenable(value)
                            ? yield value
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
            pending?.resolve(instance)
        } catch (e) {
            // a failure abandons the params/props still pending: their
            // rejections must not surface as unhandled
            markHandled(resolvedParams)
            if (resolvedProps) markHandled(Object.values(resolvedProps))
            if (pending) {
                delete registry[instanceKey]
                pending.reject(e)
            }
            throw e
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
            key: typeof token === 'function' ? getClassKey(token) : token,
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

const noop = () => {}

function markHandled(values: unknown[]) {
    for (const v of values) {
        if (isThenable(v)) v.then(undefined, noop)
    }
}

type TMaybePromise<T> = T | Promise<T>

/** Registry lookups of an unscoped resolution (never written). */
const NO_SCOPE: TRegistry = Object.freeze({}) as TRegistry

/**
 * Registry placeholder of a non-circular instance under creation. A
 * thenable whose Promise is only allocated when someone waits on it: a
 * concurrent or re-entrant resolution, or the creation itself suspending
 * (then `_get` swaps the placeholder for the Promise).
 */
class PendingCreation {
    private p?: Promise<unknown>
    private res?: (v: unknown) => void
    private rej?: (e: unknown) => void
    /** 0 = in creation, 1 = resolved, 2 = rejected */
    private state: 0 | 1 | 2 = 0
    private value: unknown

    promise(): Promise<unknown> {
        if (!this.p) {
            // a waiter that adopted this thenable may only call `then` after
            // the creation settled synchronously
            this.p =
                this.state === 1
                    ? Promise.resolve(this.value)
                    : this.state === 2
                      ? Promise.reject(this.value)
                      : new Promise((resolve, reject) => {
                            this.res = resolve
                            this.rej = reject
                        })
            this.p.catch(() => {}) // prevent unhandled rejection when no concurrent awaiter
        }
        return this.p
    }

    then<T1 = unknown, T2 = never>(
        onFulfilled?: ((v: unknown) => T1 | PromiseLike<T1>) | null,
        onRejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
    ): Promise<T1 | T2> {
        return this.promise().then(onFulfilled, onRejected)
    }

    resolve(instance: unknown) {
        this.state = 1
        this.value = instance
        this.res?.(instance)
    }

    reject(e: unknown) {
        this.state = 2
        this.value = e
        this.rej?.(e)
    }
}

interface TGetResult<IT> {
    instance: IT
    mergedProvide: TProvideRegistry
    replace?: TReplaceRegistry
}

/** Wraps a resolved (or pending) instance into a `TGetResult`. */
function getResult<IT>(
    value: unknown,
    mergedProvide: TProvideRegistry,
    replace: TReplaceRegistry | undefined,
): TMaybePromise<TGetResult<IT>> {
    return isThenable(value)
        ? Promise.resolve(value as PromiseLike<IT>).then((instance) => ({
              instance,
              mergedProvide,
              replace,
          }))
        : { instance: value as IT, mergedProvide, replace }
}

/**
 * Drives a generator whose `yield`s stand for `await`s: it runs
 * synchronously while the yielded values are not thenables and switches to
 * async at the first thenable. Returns the generator's result, or a Promise
 * of it once it went async; a synchronous failure throws.
 */
function runSyncFirst<R>(
    gen: Generator<unknown, R, unknown>,
): TMaybePromise<R> {
    let step = gen.next()
    while (!step.done) {
        if (isThenable(step.value)) {
            return resumeAsync(gen, step.value)
        }
        step = gen.next(step.value)
    }
    return step.value
}

async function resumeAsync<R>(
    gen: Generator<unknown, R, unknown>,
    pending: PromiseLike<unknown>,
): Promise<R> {
    for (;;) {
        let value: unknown
        let failed = false
        try {
            value = await pending
        } catch (e) {
            value = e
            failed = true
        }
        let step = failed ? gen.throw(value) : gen.next(value)
        while (!step.done && !isThenable(step.value)) {
            step = gen.next(step.value)
        }
        if (step.done) {
            return step.value
        }
        pending = step.value as PromiseLike<unknown>
    }
}

export function createProvideRegistry(
    ...args: [TClassConstructor<TAny> | string, TProvideFn][]
): TProvideRegistry {
    const provide: TProvideRegistry = {}
    for (const a of args) {
        const [type, fn] = a
        const key = typeof type === 'string' ? type : getClassKey(type)
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
        const key = getClassKey(type)
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
