import { TAny, TClassConstructor, TFunction, TObject } from './types'

const globalRegistry: Record<string | symbol, unknown> = {}

type TRegistry = Record<string | symbol, unknown>
type TSyncContextFn<T extends TObject = TEmpty> = (classMeta?: T & TInfactClassMeta) => void | unknown

export interface TInfactGetOptions<T extends TObject = TAny> {
    customData?: T
    provide?: TProvideRegistry
    replace?: TReplaceRegistry
    hierarchy?: string[]
    fromScope?: string | symbol
    syncContextFn?: TSyncContextFn<TAny>
}

const UNDEFINED = Symbol('undefined')

export class Infact<
    Class extends TObject = TEmpty,
    Prop extends TObject = TEmpty,
    Param extends TObject = TEmpty,
    Custom extends TObject = TAny,
> {
    protected registry: TRegistry = {};

    protected instanceRegistries: WeakMap<
        TObject,
        {
            provide: TProvideRegistry;
            replace?: TReplaceRegistry;
            customData?: Custom;
        }
    > = new WeakMap();

    protected scopes: Record<string | symbol, TRegistry> = {};

    constructor(
        protected options: TInfactOptions<Class, Prop, Param, Custom>,
    ) {}

    /**
     * Cleanup function to reset registry
     *
     * It is usefull in dev mode when server restarts
     */
    public _cleanup() {
        this.registry = {}
        this.instanceRegistries = new WeakMap()
        this.scopes = {}
    }

    public raiseEvent(
        event: 'new-instance' | 'warn' | 'error',
        // eslint-disable-next-line @typescript-eslint/ban-types
        targetClass: Function,
        message: string,
        args?: unknown[],
    ) {
        if (this.options.on) {
            this.options.on(event, targetClass, message, args)
        }
    }

    public registerScope(scopeId: string | symbol) {
        if (!this.scopes[scopeId]) {
            this.scopes[scopeId] = {}
        }
    }

    public unregisterScope(scopeId: string | symbol) {
        delete this.scopes[scopeId]
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
        provide?: TProvideRegistry;
        replace?: TReplaceRegistry;
        customData?: Custom;
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
                        instance: IT;
                        mergedProvide: TProvideRegistry;
                        replace?: TReplaceRegistry;
                    }
                  | undefined
            : {
                  instance: IT;
                  mergedProvide: TProvideRegistry;
                  replace?: TReplaceRegistry;
              }
    > {
        const hierarchy = opts?.hierarchy || []
        const provide = opts?.provide
        const replace = opts?.replace
        const syncContextFn = opts?.syncContextFn
        hierarchy.push(classConstructor.name)
        let classMeta: (Class & TInfactClassMeta<Param>) | undefined
        let instanceKey = Symbol.for(classConstructor as unknown as string)
        if (replace && replace[instanceKey]) {
            classConstructor = replace?.[instanceKey]
            instanceKey = Symbol.for(classConstructor as unknown as string)
        }
        try {
            classMeta = this.options.describeClass(classConstructor)
        } catch (e) {
            throw this.panicOwnError(classConstructor, `An error occored on "describeClass" function: ${ (e as Error).message}`, hierarchy)
        }
        if (!classMeta || !classMeta.injectable) {
            if (provide && provide[instanceKey]) {
                // allow to inject provided instances even if no @Injectable decorator called
                syncContextFn && syncContextFn(classMeta)
                return {
                    instance: await (getProvidedValue(
                        provide[instanceKey],
                    ) as Promise<IT>),
                    mergedProvide: provide,
                    replace,
                }
            }
            if (!optional) {
                throw this.panicOwnError(classConstructor, 'Class is not Injectable and not Optional.',hierarchy)
            } else {
                return undefined as O extends true
                    ?
                          | {
                                instance: IT;
                                mergedProvide: TProvideRegistry;
                                replace: TReplaceRegistry;
                            }
                          | undefined
                    : {
                          instance: IT;
                          mergedProvide: TProvideRegistry;
                          replace: TReplaceRegistry;
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
        if (scopeId && !this.scopes[scopeId]) {
            throw this.panicOwnError(
                classConstructor,
                `The requested scope "${scopeId as string}" isn't registered.`,
                hierarchy,
            )
        }
        const scope = scopeId
            ? this.scopes[scopeId]
            : ({} as TRegistry)
        const mergedProvide = {
            ...(provide || {}),
            ...(classMeta.provide || {}),
        }
        if (mergedProvide[instanceKey]) {
            syncContextFn && syncContextFn(classMeta)
            return {
                instance: await (getProvidedValue(
                    mergedProvide[instanceKey],
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
            const isCircular = !!params.find((p) => !!p.circular)
            if (isCircular) {
                registry[instanceKey] = Object.create(
                    classConstructor.prototype,
                ) // empty "instance"
            }

            // Resolving Params
            const resolvedParams = []
            for (let i = 0; i < params.length; i++) {
                const param = params[i]
                if (param.inject) {
                    if (mergedProvide && mergedProvide[param.inject]) {
                        resolvedParams[i] = getProvidedValue(
                            mergedProvide[param.inject],
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
                    })
                }
            }

            for (let i = 0; i < resolvedParams.length; i++) {
                const rp: unknown = resolvedParams[i]
                if (
                    rp &&
                    rp !== UNDEFINED &&
                    typeof (rp as Promise<unknown>).then === 'function'
                ) {
                    try {
                        syncContextFn && syncContextFn(classMeta)
                        resolvedParams[i] = await (rp as Promise<unknown>)
                    } catch (e) {
                        const param = params[i]
                        throw this.panic(
                            classConstructor,
                            e as Error,
                            `Could not inject "${
                                (param.type as unknown as TFunction).name
                            }" argument at index ${i}${
                                param.label ? ` (${param.label})` : ''
                            }. An exception occured.`,
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
                                provide: param.provide ? { ...mergedProvide, ...param.provide } : mergedProvide,
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
                if (rp && typeof (rp as Promise<unknown>).then === 'function') {
                    try {
                        syncContextFn && syncContextFn(classMeta)
                        resolvedParams[i] = await (rp as Promise<unknown>)
                    } catch (e) {
                        const param = params[i]
                        throw this.panic(
                            classConstructor,
                            e as Error,
                            `Could not inject "${
                                (param.type as unknown as TFunction).name
                            }" argument at index ${i}${
                                param.label ? ` (${param.label})` : ''
                            }. An exception occured.`,
                            hierarchy,
                        )
                    }
                }
            }

            const instance = new classConstructor(...(resolvedParams as []))
            if (isCircular) {
                Object.assign(registry[instanceKey] as TObject, instance)
            } else {
                registry[instanceKey] = instance
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
                            `Could not process prop "${prop as string}". An error occored on "describeProp" function.\n${
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
                            })
                        } catch (e) {
                            throw this.panic(
                                classConstructor,
                                e as Error,
                                `Could not inject prop "${
                                    prop as string
                                }". An exception occured: ` +
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
                                'An exception occured: ' +
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
        }
        hierarchy.pop()
        syncContextFn && syncContextFn(classMeta)
        return {
            instance: await ((scope[instanceKey] ||
                this.registry[instanceKey] ||
                globalRegistry[instanceKey]) as Promise<IT>),
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
    ) {
        this.raiseEvent('error', targetClass, text, hierarchy)
        return origError
    }

    protected panicOwnError(
    // eslint-disable-next-line @typescript-eslint/ban-types
        targetClass: Function,
        text: string,
        hierarchy?: string[],
    ) {
        const e = new Error(text)
        return this.panic(targetClass, e, text, hierarchy)
    }
}

function getProvidedValue(meta: TProvideMeta) {
    if (!meta.resolved) {
        meta.resolved = true
        meta.value = meta.fn()
    }
    return meta.value
}

export function createProvideRegistry(
    ...args: [TClassConstructor<TAny> | string, TProvideFn][]
): TProvideRegistry {
    const provide: TProvideRegistry = {}
    for (const a of args) {
        const [type, fn] = a
        const key =
            typeof type === 'string'
                ? type
                : Symbol.for(type as unknown as string)
        provide[key] = {
            fn,
            resolved: false,
        }
    }
    return provide
}
export function createReplaceRegistry(
    ...args: [TClassConstructor<TAny>, TClassConstructor<TAny>][]
): TReplaceRegistry {
    const replace: TReplaceRegistry = {}
    for (const a of args) {
        const [type, newType] = a
        const key = Symbol.for(type as unknown as string)
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
    ) => TInfactClassMeta<Param> & Class;
    describeProp?: (
        classConstructor: TClassConstructor<TAny>,
        key: string | symbol,
    ) => Prop & {
        provide?: TProvideRegistry;
    };
    resolveParam?: (opts: {
        paramMeta: TInfactClassMeta<Param>['constructorParams'][0];
        classMeta: TInfactClassMeta<Param> & Class;
        classConstructor: TFunction;
        scopeId?: string | symbol;
        index: number;
        customData?: Custom;
    }) => unknown | Promise<unknown>;
    resolveProp?: (opts: {
        instance: TObject;
        key: string | symbol;
        initialValue: unknown;
        propMeta: Prop;
        scopeId?: string | symbol;
        classMeta: TInfactClassMeta<Param> & Class;
        classConstructor: TFunction;
        customData?: Custom;
    }) => unknown | Promise<unknown>;
    storeProvideRegByInstance?: boolean;
    // eslint-disable-next-line @typescript-eslint/ban-types
    on?: (
        event: 'new-instance' | 'warn' | 'error',
        // eslint-disable-next-line @typescript-eslint/ban-types
        targetClass: Function,
        message: string,
        args?: unknown[],
    ) => void;
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
    label?: string;
    circular?: () => TClassConstructor<TAny>;
    type?: TFunction;
    inject?: string | symbol;
    nullable?: boolean;
    fromScope?: string | symbol;
    provide?: TProvideRegistry;
    optional?: boolean; // same as nullable for compatibility
}

interface TProvideMeta {
    fn: TProvideFn, 
    resolved?: boolean, 
    value?: unknown
}

export type TProvideRegistry = Record<string | symbol, TProvideMeta>
export type TReplaceRegistry = Record<symbol, TClassConstructor<TAny>>;
export type TProvideFn = () => TAny
