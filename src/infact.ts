import { TAny, TClassConstructor, TFunction, TObject } from './types'
import { getConstructor } from './utils/helpers'
import { log, logError, warn } from './utils/log'
import { panic } from './utils/panic'

const globalRegistry: Record<string | symbol, unknown> = {}

export class Infact<T extends TInfactClassMeta = TInfactClassMeta> {
    protected registry: Record<string | symbol, unknown> = {}
    
    protected provideRegByInstance: WeakMap<TObject, TProvideRegistry> = new WeakMap()

    constructor(protected options: TInfactOptions<T>) {}

    public async getForInstance<T = unknown>(instance: TObject, classConstructor: TClassConstructor<T>): Promise<T> {
        return this.get(classConstructor, this.provideRegByInstance.get(instance) || {})
    }

    public async get<T = unknown>(classConstructor: TClassConstructor<T>, provide?: TProvideRegistry, hierarchy?: string[]): Promise<T> {
        const { instance, mergedProvide } = await this._get(classConstructor, provide, hierarchy)
        if (this.options.storeProvideRegByInstance) {
            this.provideRegByInstance.set(instance as TObject, mergedProvide)
        }
        return instance
    }

    private async _get<T = unknown>(classConstructor: TClassConstructor<T>, provide?: TProvideRegistry, hierarchy?: string[]): Promise<{ instance: T, mergedProvide: TProvideRegistry}> {
        hierarchy = (hierarchy || [])
        hierarchy.push(classConstructor.name)
        const classMeta = this.options.describeClass(classConstructor)
        if (!classMeta || !classMeta.injectable) {
            throw panic(`Could not instantiate Injectable "${ classConstructor.name }". `
                + 'Please check if you used @Injectable decorator or if you properly typed arguments.\n'
                + 'Hierarchy:\n' + hierarchy.join(' -> '))
        }
        const instanceKey = Symbol.for(classConstructor as unknown as string)
        const mergedProvide = {...(provide || {}), ...(classMeta.provide || {})}
        if (mergedProvide[instanceKey]) {
            return { instance: await (getProvidedValue(mergedProvide[instanceKey]) as Promise<T>), mergedProvide }
        }
        if (!this.registry[instanceKey] && !globalRegistry[instanceKey]) {
            const registry = classMeta.global ? globalRegistry : this.registry
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
                        panic(`Could not inject ${JSON.stringify(param.inject)} to "${ classConstructor.name }" to argument ${ param.label ? `labeled as "${ param.label }"` : `with index ${ i }` }`
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
                        resolvedParams[i] = this.get(param.type as TClassConstructor, mergedProvide, hierarchy)
                    }
                }
            }

            for (let i = 0; i < resolvedParams.length; i++) {
                try {
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
        hierarchy.pop()
        return { instance: await ((this.registry[instanceKey] || globalRegistry[instanceKey]) as Promise<T>), mergedProvide }
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
