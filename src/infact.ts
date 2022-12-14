import { TAny, TClassConstructor, TFunction, TObject } from './types'
import { getConstructor } from './utils/helpers'
import { log, logError, warn } from './utils/log'
import { panic } from './utils/panic'

const globalRegistry: Record<string | symbol, unknown> = {}

type TRegistry = Record<string | symbol, unknown>
type TSyncContextFn<T extends TInfactClassMeta = TInfactClassMeta> = (classMeta?: T) => void | unknown

export class Infact<T extends TInfactClassMeta = TInfactClassMeta> {
    protected registry: TRegistry = {}
    
    protected provideRegByInstance: WeakMap<TObject, TProvideRegistry> = new WeakMap()

    protected scopes: Record<string | symbol, TRegistry> = {}

    constructor(protected options: TInfactOptions<T>) {}

    protected _silent = false

    public silent(value = true) {
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

    public async getForInstance<IT = unknown>(instance: TObject, classConstructor: TClassConstructor<IT>, hierarchy?: string[], syncContextFn?: TSyncContextFn<T>): Promise<IT> {
        return this.get(classConstructor, this.getProvideRegByInstnce(instance) || {}, hierarchy, syncContextFn)
    }

    public async get<IT = unknown>(classConstructor: TClassConstructor<IT>, provide?: TProvideRegistry, hierarchy?: string[], syncContextFn?: TSyncContextFn<T>): Promise<IT> {
        const { instance, mergedProvide } = await this._get(classConstructor, provide, hierarchy, syncContextFn)
        if (this.options.storeProvideRegByInstance) {
            this.setProvideRegByInstance(instance as TObject, mergedProvide)
        }
        return instance
    }

    public setProvideRegByInstance(instance: TObject, provide: TProvideRegistry) {
        this.provideRegByInstance.set(instance, provide)
    }

    public getProvideRegByInstnce(instance: TObject): TProvideRegistry {
        return this.provideRegByInstance.get(instance) || {}
    }

    private async _get<IT = unknown>(classConstructor: TClassConstructor<IT>, provide?: TProvideRegistry, hierarchy?: string[], syncContextFn?: TSyncContextFn<T>): Promise<{ instance: IT, mergedProvide: TProvideRegistry}> {
        hierarchy = (hierarchy || [])
        hierarchy.push(classConstructor.name)
        let classMeta: T | undefined
        try {
            classMeta = this.options.describeClass(classConstructor)
        } catch (e) {
            throw panic(`Could not instantiate "${ classConstructor.name }". `
                + `An error occored on "describeClass" function.\n${ (e as Error).message }\n`
                + 'Hierarchy:\n' + hierarchy.join(' -> '))
        }
        const instanceKey = Symbol.for(classConstructor as unknown as string)
        if (!classMeta || !classMeta.injectable) {
            if (provide && provide[instanceKey]) {
                // allow to inject provided instances even if no @Injectable decorator called
                syncContextFn && syncContextFn(classMeta)
                return { instance: await (getProvidedValue(provide[instanceKey]) as Promise<IT>), mergedProvide: provide }
            }
            throw panic(`Could not instantiate Injectable "${ classConstructor.name }". `
                + 'Please check if the class is injectable or if you properly typed arguments.\n'
                + 'Hierarchy:\n' + hierarchy.join(' -> '))
        }
        if (classMeta.scopeId && classMeta.global) {
            throw panic(`Could not instantiate scoped Injectable "${ classConstructor.name }" for scope "${ classMeta.scopeId as string }". `
            + 'The scoped Injectable is not supported for Global scope.\n'
            + 'Hierarchy:\n' + hierarchy.join(' -> '))
        }
        if (classMeta.scopeId && !this.scopes[classMeta.scopeId]) {
            throw panic(`Could not instantiate scoped Injectable "${ classConstructor.name }" for scope "${ classMeta.scopeId as string }". `
            + 'The requested scope isn\'t registered.\n'
            + 'Hierarchy:\n' + hierarchy.join(' -> '))
        }
        const scope = classMeta.scopeId ? this.scopes[classMeta.scopeId] : {} as TRegistry
        const mergedProvide = {...(provide || {}), ...(classMeta.provide || {})}
        if (mergedProvide[instanceKey]) {
            syncContextFn && syncContextFn(classMeta)
            return { instance: await (getProvidedValue(mergedProvide[instanceKey]) as Promise<IT>), mergedProvide }
        }
        if (!this.registry[instanceKey] && !globalRegistry[instanceKey] && !scope[instanceKey]) {
            const registry = classMeta.scopeId ? scope : classMeta.global ? globalRegistry : this.registry
            const params = classMeta.constructorParams || []
            const isCircular = !!params.find(p => !!p.circular)
            if (isCircular) {
                registry[instanceKey] = Object.create(classConstructor.prototype) // empty "instance"
            }
            const resolvedParams = []
            for (let i = 0; i < params.length; i++) {
                const param = params[i]
                if (param.inject) {
                    if (mergedProvide && mergedProvide[param.inject]) {
                        resolvedParams[i] = getProvidedValue(mergedProvide[param.inject])
                    } else {
                        /* istanbul ignore next line */
                        throw panic(`Could not inject ${JSON.stringify(param.inject)} to "${ classConstructor.name }" to argument ${ param.label ? `labeled as "${ param.label }"` : `with index ${ i }` }`
                            + '\nHierarchy:\n' + hierarchy.join(' -> '))
                    }                        
                } else if (this.options.resolveParam) {
                    resolvedParams[i] = this.options.resolveParam(param, classMeta, i)
                }
                if (typeof resolvedParams[i] === 'undefined') {
                    if (param.type === undefined && !param.circular) {
                        warn(`${ classConstructor.name }.constructor() expects argument ${ param.label ? `labeled as "${ param.label }"` : `#${ i }`} that is undefined. This might happen when Circular Dependency occurs. To handle Circular Dependencies please specify circular meta for param.`)
                    } else if (param.type === undefined && param.circular) {
                        param.type = (param.circular as TFunction)() as TFunction
                    }
                    if (typeof param.type === 'function') {
                        if ([String, Number, Date, Array].includes(param.type as TAny)) {
                            throw panic(`Could not inject "${ (param.type as unknown as TFunction).name }" to "${ classConstructor.name }" `
                                + `constructor at index ${ i }${ param.label ? ` (${ param.label })` : '' }. The param was not resolved to a value.`
                                + '\nHierarchy:\n' + hierarchy.join(' -> '))
                        }
                        resolvedParams[i] = this.get(param.type as TClassConstructor, mergedProvide, hierarchy, syncContextFn)
                    }
                }
            }

            for (let i = 0; i < resolvedParams.length; i++) {
                try {
                    syncContextFn && syncContextFn(classMeta)
                    resolvedParams[i] = resolvedParams[i] ? await resolvedParams[i] : resolvedParams[i]
                } catch (e) {
                    const param = params[i]
                    logError(`Could not inject "${ (param.type as unknown as TFunction).name }" to "${ classConstructor.name }" `
                    + `constructor at index ${ i }${ param.label ? ` (${ param.label })` : '' }. An exception occured.`
                    + '\nHierarchy:\n' + hierarchy.join(' -> '))                    
                    throw e
                }
            }

            if (isCircular) {
                Object.assign(registry[instanceKey] as TObject, new classConstructor(...(resolvedParams as [])))
            } else {
                registry[instanceKey] = new classConstructor(...(resolvedParams as []))
            }
            if (!this._silent) {
                log(`Class "${ __DYE_BOLD__ + classConstructor.name + __DYE_BOLD_OFF__ + __DYE_DIM__}" instantiated with: ${ __DYE_BLUE__ }[${ resolvedParams.map(p => {
                    switch (typeof p) {
                        case 'number':
                        case 'boolean':
                            return p
                        case 'string':
                            return `"${ __DYE_GREEN_BRIGHT__ }...${ __DYE_BLUE__ }"`
                        case 'object':
                            if (getConstructor(p)) return getConstructor(p).name
                            return '{}'
                        default: return '*'
                    }
                }).join(', ') }]`)
            }
        }
        hierarchy.pop()
        syncContextFn && syncContextFn(classMeta)
        return { instance: await ((scope[instanceKey] || this.registry[instanceKey] || globalRegistry[instanceKey]) as Promise<IT>), mergedProvide }
    }
}

function getProvidedValue(meta: TProvideMeta) {
    if (!meta.resolved) {
        meta.resolved = true
        meta.value = meta.fn()
    }
    return meta.value
}

export function createProvideRegistry(...args: [TClassConstructor | string, TProvideFn][]): TProvideRegistry {
    const provide: TProvideRegistry = {}
    for (const a of args) {
        const [type, fn] = a
        const key = typeof type === 'string' ? type : Symbol.for(type as unknown as string)
        provide[key] = {
            fn,
            resolved: false,
        }
    }
    return provide
}

export interface TInfactOptions<T extends TInfactClassMeta = TInfactClassMeta> {
    describeClass: (classConstructor: TClassConstructor) => T
    resolveParam?: (paramMeta: T['constructorParams'][0], classMeta: T, index: number) => unknown
    storeProvideRegByInstance?: boolean
}

export interface TInfactClassMeta<P extends TInfactConstructorParamMeta = TInfactConstructorParamMeta> {
    injectable: boolean
    global?: boolean
    provide?: TProvideRegistry
    scopeId?: string | symbol
    constructorParams: P[]
}

export interface TInfactConstructorParamMeta {
    label?: string
    circular?: () => TClassConstructor
    type?: TFunction
    inject?: string | symbol
}

interface TProvideMeta {
    fn: TProvideFn, 
    resolved?: boolean, 
    value?: unknown
}

export type TProvideRegistry = Record<string | symbol, TProvideMeta>
export type TProvideFn = () => TAny
