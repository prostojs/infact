import { TAny, TClassConstructor, TFunction, TObject } from './types'
import { getConstructor } from './utils/helpers'

const globalRegistry: Record<string | symbol, unknown> = {}

type TRegistry = Record<string | symbol, unknown>
type TSyncContextFn<T extends TObject = TEmpty> = (classMeta?: T & TInfactClassMeta) => void | unknown

export interface TInfactGetOptions<T extends TObject = TAny> {
    customData?: T
    provide?: TProvideRegistry
    replace?: TReplaceRegistry
    hierarchy?: string[]
    syncContextFn?: TSyncContextFn<TAny>
}

const UNDEFINED = Symbol('undefined')

interface TConsoleBase { error: ((...args: any) => void), warn: ((...args: any) => void), log: ((...args: any) => void), info: ((...args: any) => void) }

export class Infact<
    Class extends TObject = TEmpty,
    Prop extends TObject = TEmpty,
    Param extends TObject = TEmpty,
    Custom extends TObject = TAny,
> {
    protected registry: TRegistry = {};

    protected instanceRegistries: WeakMap<TObject, {provide: TProvideRegistry, replace?: TReplaceRegistry}> =
        new WeakMap();

    protected scopes: Record<string | symbol, TRegistry> = {};

    protected logger: TConsoleBase;

    constructor(protected options: TInfactOptions<Class, Prop, Param, Custom>) {
        this.logger = options.logger || console
    }

    protected _silent: boolean | 'logs' = false;

    public setLogger(logger: TConsoleBase) {
        this.logger = logger
    }

    public silent(value: boolean | 'logs' = 'logs') {
        this._silent = value
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
    ) {
        this.instanceRegistries.set(instance, { provide, replace })
    }

    public getInstanceRegistries(instance: TObject): { provide?: TProvideRegistry, replace?: TReplaceRegistry } {
        return this.instanceRegistries.get(instance) || {}
    }

    private async _get<IT extends TObject, O extends boolean>(
        classConstructor: TClassConstructor<IT>,
        opts?: TInfactGetOptions<Custom>,
        optional?: boolean,
    ): Promise<
        O extends true
            ? { instance: IT; mergedProvide: TProvideRegistry; replace?: TReplaceRegistry } | undefined
            : { instance: IT; mergedProvide: TProvideRegistry; replace?: TReplaceRegistry }
    > {
        const hierarchy = opts?.hierarchy || []
        const provide = opts?.provide
        const replace = opts?.replace
        const syncContextFn = opts?.syncContextFn
        hierarchy.push(classConstructor.name)
        let classMeta: (Class & TInfactClassMeta<Param>) | undefined
        let instanceKey = Symbol.for(classConstructor as unknown as string)
        if (
            replace &&
            replace[instanceKey]
        ) {
            classConstructor = replace?.[instanceKey]
            instanceKey = Symbol.for(classConstructor as unknown as string)
        }
        try {
            classMeta = this.options.describeClass(classConstructor)
        } catch (e) {
            throw this.panicOwnError(
                `Could not instantiate "${classConstructor.name}". ` +
                    `An error occored on "describeClass" function.\n${
                        (e as Error).message
                    }`,
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
                    ) as Promise<IT>),
                    mergedProvide: provide,
                    replace,
                }
            }
            if (!optional) {
                throw this.panicOwnError(
                    `Could not instantiate Injectable "${classConstructor.name}". ` +
                        'Please check if the class is injectable or if you properly typed arguments.',
                    hierarchy,
                )
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
        if (classMeta.scopeId && classMeta.global) {
            throw this.panicOwnError(
                `Could not instantiate scoped Injectable "${
                    classConstructor.name
                }" for scope "${classMeta.scopeId as string}". ` +
                    'The scoped Injectable is not supported for Global scope.',
                hierarchy,
            )
        }
        if (classMeta.scopeId && !this.scopes[classMeta.scopeId]) {
            throw this.panicOwnError(
                `Could not instantiate scoped Injectable "${
                    classConstructor.name
                }" for scope "${classMeta.scopeId as string}". ` +
                    'The requested scope isn\'t registered.',
                hierarchy,
            )
        }
        const scope = classMeta.scopeId
            ? this.scopes[classMeta.scopeId]
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
            !this.registry[instanceKey] &&
            !globalRegistry[instanceKey] &&
            !scope[instanceKey]
        ) {
            const registry = classMeta.scopeId
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
                            `Could not inject ${JSON.stringify(
                                param.inject,
                            )} to "${classConstructor.name}" to argument ${
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
                            e as Error,
                            `Could not inject "${
                                (param.type as unknown as TFunction).name
                            }" to "${classConstructor.name}" ` +
                                `constructor at index ${i}${
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
                        if (this._silent === false) {
                            this.logger.warn(
                                `${
                                    classConstructor.name
                                }.constructor() expects argument ${
                                    param.label
                                        ? `labeled as "${param.label}"`
                                        : `#${i}`
                                } that is undefined. This might happen when Circular Dependency occurs. To handle Circular Dependencies please specify circular meta for param.`,
                            )
                        }
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
                                    `Could not inject "${
                                        (param.type as unknown as TFunction)
                                            .name
                                    }" to "${classConstructor.name}" ` +
                                        `constructor at index ${i}${
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
                                provide: mergedProvide,
                                hierarchy,
                                syncContextFn,
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
                            e as Error,
                            `Could not inject "${
                                (param.type as unknown as TFunction).name
                            }" to "${classConstructor.name}" ` +
                                `constructor at index ${i}${
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
                            e as Error,
                            `Could not process prop "${prop as string}" of "${
                                classConstructor.name
                            }". ` +
                                `An error occored on "describeProp" function.\n${
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
                                instance,
                                propMeta,
                                customData: opts?.customData,
                            })
                        } catch (e) {
                            throw this.panic(
                                e as Error,
                                `Could not inject prop "${
                                    prop as string
                                }" to "${classConstructor.name}". ` +
                                    'An exception occured: ' +
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
                            e as Error,
                            `Could not inject prop "${prop}" to "${classConstructor.name}". ` +
                                'An exception occured: ' +
                                (e as Error).message,
                            hierarchy,
                        )
                    }
                }
                Object.assign(instance as TObject, resolvedProps)
            }

            if (this._silent === false) {
                this.logger.info(
                    `Class "${
                        __DYE_BOLD__ +
                        classConstructor.name +
                        __DYE_BOLD_OFF__ +
                        __DYE_DIM__
                    }" instantiated with: ${__DYE_BLUE__}[${resolvedParams
                        .map((p) => {
                            switch (typeof p) {
                                case 'number':
                                case 'boolean':
                                    return p
                                case 'string':
                                    return `"${__DYE_GREEN_BRIGHT__}...${__DYE_BLUE__}"`
                                case 'object':
                                    if (getConstructor(p))
                                        return getConstructor(p).name
                                    return '{}'
                                default:
                                    return '*'
                            }
                        })
                        .join(', ')}]`,
                )
            }
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

    protected panic(origError: Error, text: string, hierarchy?: string[]) {
        if (this._silent === true) {
            // do nothing
        } else {
            this.logger.error(
                text +
                    (hierarchy
                        ? '\nHierarchy:\n' + hierarchy.join(' -> ')
                        : ''),
            )
        }
        return origError
    }

    protected panicOwnError(text: string, hierarchy?: string[]) {
        const e = new Error(
            text + (hierarchy ? '\nHierarchy:\n' + hierarchy.join(' -> ') : ''),
        )
        if (this._silent === true) {
            return e
        } else {
            this.logger.error(e)
            return e
        }
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

export interface TInfactOptions<Class extends TObject = TEmpty, Prop extends TObject = TEmpty, Param extends TObject = TEmpty, Custom extends TObject = TAny> {
    describeClass: (classConstructor: TClassConstructor<TAny>) => TInfactClassMeta<Param> & Class
    describeProp?: (classConstructor: TClassConstructor<TAny>, key: string | symbol) => Prop
    resolveParam?: (opts: {
        paramMeta: (TInfactClassMeta<Param>)['constructorParams'][0],
        classMeta: TInfactClassMeta<Param> & Class,
        classConstructor: TFunction
        index: number
        customData?: Custom
    }) => unknown | Promise<unknown>
    resolveProp?: (opts: {
        instance: TObject,
        key: string | symbol,
        initialValue: unknown,
        propMeta: Prop,
        classMeta: TInfactClassMeta<Param> & Class
        classConstructor: TFunction
        customData?: Custom
    }) => unknown | Promise<unknown>
    storeProvideRegByInstance?: boolean
    logger?: TConsoleBase
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
    optional?: boolean // same as nullable for compatibility
}

interface TProvideMeta {
    fn: TProvideFn, 
    resolved?: boolean, 
    value?: unknown
}

export type TProvideRegistry = Record<string | symbol, TProvideMeta>
export type TReplaceRegistry = Record<symbol, TClassConstructor<TAny>>;
export type TProvideFn = () => TAny
