import {
    Infact,
    TInfactClassMeta,
    createProvideRegistry,
    createReplaceRegistry,
    TInfactOptions,
} from '..'
import { CircularTestClass1 } from './circular1.artifacts'
import { CircularTestClass2 } from './circular2.artifacts'
import {
    ChildClassTestClass1,
    ChildClassTestClass2,
    ParentTestClass,
    ProviderTestClass1,
    ProviderTestClass2,
    WithProps,
    OptionalInject,
    RequiredInject,
    SimpleDep,
    ServiceWithDep,
    OriginalService,
    ReplacementService,
    GlobalService,
    ScopedService,
    CircularNonEnum,
    CircularNonEnumDep,
} from './infact.artifacts'

function symbol(v: unknown) {
    return Symbol.for(v as string)
}

interface Empty {}

const meta: Record<
    symbol,
    TInfactClassMeta<Empty> & TMeta & Record<string | symbol, unknown>
> = {
    [symbol(ParentTestClass)]: {
        injectable: true,
        constructorParams: [
            { type: ChildClassTestClass1 },
            { type: ChildClassTestClass2 },
            { type: ProviderTestClass1, inject: 'custom-provider-1' },
            { type: ProviderTestClass2 },
        ],
        provide: createProvideRegistry(
            [
                ProviderTestClass2,
                () => new ProviderTestClass2('custom by type'),
            ],
            [
                'custom-provider-1',
                () => new ProviderTestClass1('custom by string'),
            ],
        ),
    },
    [symbol(ChildClassTestClass1)]: {
        injectable: true,
        constructorParams: [
            { type: ProviderTestClass1 },
            { type: ProviderTestClass2 },
        ],
    },
    [symbol(ChildClassTestClass2)]: {
        injectable: true,
        constructorParams: [
            { type: ProviderTestClass1, inject: 'custom-provider-1' },
            { type: ProviderTestClass2 },
            { type: ProviderTestClass1, inject: 'custom-provider-1' },
            { type: ProviderTestClass1 },
        ],
        provide: createProvideRegistry([
            ProviderTestClass2,
            () => new ProviderTestClass2('custom for child'),
        ]),
    },
    [symbol(ProviderTestClass1)]: {
        injectable: true,
        constructorParams: [],
    },
    [symbol(ProviderTestClass2)]: {
        injectable: true,
        constructorParams: [],
    },

    [symbol(CircularTestClass1)]: {
        injectable: true,
        constructorParams: [
            { type: undefined, circular: () => CircularTestClass2 },
        ],
    },
    [symbol(CircularTestClass2)]: {
        injectable: true,
        constructorParams: [
            { type: undefined, circular: () => CircularTestClass1 },
            { type: String },
        ],
    },
    [symbol(WithProps)]: {
        injectable: true,
        constructorParams: [],
        properties: ['prop1', 'prop2'],
        prop2: {
            resolve: (v: number) => v + 1,
        },
        prop1: {
            resolve: () => 'resolved',
        },
    },
    [symbol(OptionalInject)]: {
        injectable: true,
        constructorParams: [
            { type: Object, inject: 'optional-inject', nullable: true },
        ],
    },
    [symbol(RequiredInject)]: {
        injectable: true,
        constructorParams: [
            { type: String, inject: 'required-inject', nullable: false },
        ],
    },
    [symbol(SimpleDep)]: {
        injectable: true,
        constructorParams: [],
    },
    [symbol(ServiceWithDep)]: {
        injectable: true,
        constructorParams: [{ type: SimpleDep }],
    },
    [symbol(OriginalService)]: {
        injectable: true,
        constructorParams: [],
    },
    [symbol(ReplacementService)]: {
        injectable: true,
        constructorParams: [],
    },
    [symbol(GlobalService)]: {
        injectable: true,
        global: true,
        constructorParams: [],
    },
    [symbol(ScopedService)]: {
        injectable: true,
        constructorParams: [],
    },
    [symbol(CircularNonEnum)]: {
        injectable: true,
        constructorParams: [
            { type: undefined, circular: () => CircularNonEnumDep },
        ],
    },
    [symbol(CircularNonEnumDep)]: {
        injectable: true,
        constructorParams: [
            { type: undefined, circular: () => CircularNonEnum },
        ],
    },
}

interface TMeta {
    resolve?: (v: unknown) => unknown
    propList?: string[]
}

const options: TInfactOptions<TMeta, TMeta, Empty> = {
    describeClass: (c) => {
        return meta[symbol(c)]
    },
    resolveParam: ({ paramMeta }) => {
        return paramMeta.type === String ? 'resolved string' : undefined
    },
    describeProp(c, key) {
        return meta[symbol(c)][key as keyof Record<string, unknown>] as TMeta
    },
    resolveProp({ initialValue, propMeta }) {
        return propMeta?.resolve && propMeta?.resolve(initialValue)
    },
    storeProvideRegByInstance: true,
}

const infact = new Infact<TMeta>(options)
const infact2 = new Infact<TMeta>(options)

describe('infact', () => {
    let parent: ParentTestClass
    let c1: CircularTestClass1
    let c2: CircularTestClass2
    beforeAll(async () => {
        parent = await infact.get(ParentTestClass)
        c1 = await infact.get(CircularTestClass1)
        c2 = await infact2.get(CircularTestClass2)
    })

    it('must instantiate ParentTestClass', () => {
        expect(parent).toBeInstanceOf(ParentTestClass)
    })

    it('must instantiate Basic Child Dependencies', () => {
        expect(parent.child1).toBeInstanceOf(ChildClassTestClass1)
        expect(parent.child2).toBeInstanceOf(ChildClassTestClass2)
    })

    it('must instantiate Basic Child Dependencies', () => {
        expect(parent.child1).toBeInstanceOf(ChildClassTestClass1)
        expect(parent.child1.provider1).toBeInstanceOf(ProviderTestClass1)
        expect(parent.child1.provider1.config).toBeUndefined()
        expect(parent.child2).toBeInstanceOf(ChildClassTestClass2)
    })

    it('must inject provided by string key dependency', () => {
        expect(parent.child2.provider1.config).toBe('custom by string')
    })

    it('must inject provided by type dependency', () => {
        expect(parent.child1.provider2.config).toBe('custom by type')
    })

    it('must inject provided by type dependency overwriten by child', () => {
        expect(parent.child2.provider2.config).toBe('custom for child')
    })

    it('must inject same provided depency instance', () => {
        expect(parent.child1.provider2).toBe(parent.provider2)
        expect(parent.child2.provider1).toBe(parent.provider1)
        expect(parent.child2.provider1).toBe(parent.child2.provider11)
    })

    it('must inject same depency instance', () => {
        expect(parent.child2.provider12).toBe(parent.child1.provider1)
    })

    it('must handle circular deps', () => {
        expect(c1.c2.c1).toBe(c1)
        expect(c1.c2.c1.c2).toBe(c1.c2)
        expect(c2.c1.c2).toBe(c2)
        expect(c2.c1.c2.c1).toBe(c2.c1)
    })

    it('must use resolveParam function and inject provided value', () => {
        expect(c2.str).toBe('resolved string')
    })

    it('must get classInstance for instance', async () => {
        const c2 = await infact.getForInstance(
            parent.child1,
            ProviderTestClass2,
        )
        expect(c2.config).toBe('custom by type')
    })

    it('must process instance props', async () => {
        const c = await infact.get(WithProps)
        expect(c.prop2).toBe(6)
        expect(c.prop1).toBe('resolved')
    })

    it('must let optional inject be empty', async () => {
        const c = await infact.get(OptionalInject)
        expect(c.data).toBe(undefined)
    })

    it('must not let required inject be empty', async () => {
        await expect(
            async () => await infact.get(RequiredInject),
        ).rejects.toMatchInlineSnapshot(
            '[Error: Could not inject "required-inject" argument with index 0]',
        )
    })
})

describe('race condition: concurrent get() calls', () => {
    it('should return the same instance for concurrent get() calls', async () => {
        const freshInfact = new Infact<TMeta>(options)
        const [a, b] = await Promise.all([
            freshInfact.get(ServiceWithDep),
            freshInfact.get(ServiceWithDep),
        ])
        expect(a).toBe(b)
    })

    it('should return the same dep instance for concurrent get() calls', async () => {
        const freshInfact = new Infact<TMeta>(options)
        const [a, b] = await Promise.all([
            freshInfact.get(ServiceWithDep),
            freshInfact.get(ServiceWithDep),
        ])
        expect(a.dep).toBe(b.dep)
    })
})

describe('circular deps: Object.assign limitations', () => {
    it('should preserve non-enumerable properties on circular instances', async () => {
        const freshInfact = new Infact<TMeta>(options)
        const instance = await freshInfact.get(CircularNonEnum)
        // Object.assign only copies enumerable own properties.
        // The 'hidden' property is defined as non-enumerable in the constructor.
        // If the circular dep shell is filled via Object.assign, this will be undefined.
        expect(instance.hidden).toBe(42)
    })
})

describe('scopes', () => {
    it('must create scoped instances isolated from instance registry', async () => {
        const freshInfact = new Infact<TMeta>(options)
        const scopeId = 'test-scope'
        freshInfact.registerScope(scopeId)

        // Resolve without scope — goes into instance registry
        const global1 = await freshInfact.get(ScopedService)

        // Resolve with fromScope — should create a NEW instance in the scope
        const scoped1 = await freshInfact.get(ScopedService, {
            fromScope: scopeId,
        })

        expect(scoped1).not.toBe(global1)
        expect(scoped1).toBeInstanceOf(ScopedService)
    })

    it('must return the same scoped instance on repeated resolution', async () => {
        const freshInfact = new Infact<TMeta>(options)
        const scopeId = 'test-scope-2'
        freshInfact.registerScope(scopeId)

        const a = await freshInfact.get(ScopedService, {
            fromScope: scopeId,
        })
        const b = await freshInfact.get(ScopedService, {
            fromScope: scopeId,
        })

        expect(a).toBe(b)
    })

    it('must isolate instances between different scopes', async () => {
        const freshInfact = new Infact<TMeta>(options)
        freshInfact.registerScope('scope-a')
        freshInfact.registerScope('scope-b')

        const a = await freshInfact.get(ScopedService, {
            fromScope: 'scope-a',
        })
        const b = await freshInfact.get(ScopedService, {
            fromScope: 'scope-b',
        })

        expect(a).not.toBe(b)
    })

    it('must throw when resolving from unregistered scope', async () => {
        const freshInfact = new Infact<TMeta>(options)
        await expect(
            freshInfact.get(ScopedService, { fromScope: 'nonexistent' }),
        ).rejects.toThrow("isn't registered")
    })

    it('must discard scoped instances on unregisterScope', async () => {
        const freshInfact = new Infact<TMeta>(options)
        const scopeId = 'disposable-scope'
        freshInfact.registerScope(scopeId)

        const before = await freshInfact.get(ScopedService, {
            fromScope: scopeId,
        })

        freshInfact.unregisterScope(scopeId)
        freshInfact.registerScope(scopeId)

        const after = await freshInfact.get(ScopedService, {
            fromScope: scopeId,
        })

        expect(before).not.toBe(after)
    })

    it('must throw when class has both scopeId and global', async () => {
        const scopedGlobalMeta = {
            ...meta,
            [symbol(GlobalService)]: {
                injectable: true,
                global: true,
                scopeId: 'some-scope',
                constructorParams: [],
            },
        }
        const freshInfact = new Infact<TMeta>({
            ...options,
            describeClass: (c) => scopedGlobalMeta[symbol(c)],
        })
        freshInfact.registerScope('some-scope')
        await expect(freshInfact.get(GlobalService)).rejects.toThrow(
            'scoped Injectable is not supported for Global scope',
        )
    })
})

describe('replace registry', () => {
    it('must substitute class via replace registry', async () => {
        const freshInfact = new Infact<TMeta>(options)
        const replace = createReplaceRegistry([
            OriginalService,
            ReplacementService,
        ])

        const instance = await freshInfact.get(OriginalService, { replace })

        expect(instance).toBeInstanceOf(ReplacementService)
        expect((instance as ReplacementService).type).toBe('replacement')
    })

    it('must use same replacement instance as singleton', async () => {
        const freshInfact = new Infact<TMeta>(options)
        const replace = createReplaceRegistry([
            OriginalService,
            ReplacementService,
        ])

        const a = await freshInfact.get(OriginalService, { replace })
        const b = await freshInfact.get(OriginalService, { replace })

        expect(a).toBe(b)
    })
})

describe('global instances', () => {
    it('must share global instances across Infact instances', async () => {
        const infactA = new Infact<TMeta>(options)
        const infactB = new Infact<TMeta>(options)

        const a = await infactA.get(GlobalService)
        const b = await infactB.get(GlobalService)

        expect(a).toBe(b)
    })
})

describe('_cleanup', () => {
    it('must reset instance registry so new instances are created', async () => {
        const freshInfact = new Infact<TMeta>(options)

        const before = await freshInfact.get(SimpleDep)
        freshInfact._cleanup()
        const after = await freshInfact.get(SimpleDep)

        expect(before).not.toBe(after)
    })

    it('must reset scopes', async () => {
        const freshInfact = new Infact<TMeta>(options)
        freshInfact.registerScope('s')
        await freshInfact.get(ScopedService, { fromScope: 's' })

        freshInfact._cleanup()

        // Scope no longer exists after cleanup
        await expect(
            freshInfact.get(ScopedService, { fromScope: 's' }),
        ).rejects.toThrow("isn't registered")
    })
})

describe('error paths', () => {
    it('must throw for non-injectable, non-optional class', async () => {
        class NotInjectable {}
        const noMeta = {
            [symbol(NotInjectable)]: {
                injectable: false,
                constructorParams: [],
            },
        }
        const freshInfact = new Infact<TMeta>({
            ...options,
            describeClass: (c) =>
                (noMeta as Record<symbol, TInfactClassMeta<Empty> & TMeta>)[
                    symbol(c)
                ],
        })
        await expect(freshInfact.get(NotInjectable)).rejects.toThrow(
            'Class is not Injectable and not Optional',
        )
    })

    it('must throw when describeClass throws', async () => {
        class BadClass {}
        const freshInfact = new Infact<TMeta>({
            ...options,
            describeClass: () => {
                throw new Error('metadata failure')
            },
        })
        await expect(freshInfact.get(BadClass)).rejects.toThrow(
            'metadata failure',
        )
    })

    it('must invoke on() callback for error events', async () => {
        class NotInjectable2 {}
        const events: string[] = []
        const noMeta = {
            [symbol(NotInjectable2)]: {
                injectable: false,
                constructorParams: [],
            },
        }
        const freshInfact = new Infact<TMeta>({
            ...options,
            describeClass: (c) =>
                (noMeta as Record<symbol, TInfactClassMeta<Empty> & TMeta>)[
                    symbol(c)
                ],
            on(event) {
                events.push(event)
            },
        })
        await expect(freshInfact.get(NotInjectable2)).rejects.toThrow()
        expect(events).toContain('error')
    })
})
