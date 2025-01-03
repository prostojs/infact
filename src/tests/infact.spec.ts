import { Infact, TInfactClassMeta, createProvideRegistry, TInfactOptions } from '..'
import { CircularTestClass1 } from './circular1.artifacts'
import { CircularTestClass2 } from './circular2.artifacts'
import { ChildClassTestClass1, ChildClassTestClass2, ParentTestClass, ProviderTestClass1, ProviderTestClass2, WithProps, OptionalInject, RequiredInject } from './infact.artifacts'

function symbol(v: unknown) {
    return Symbol.for(v as string)
}

interface Empty {}

const meta: Record<symbol, TInfactClassMeta<Empty> & TMeta & Record<string | symbol, unknown>> = {
    [symbol(ParentTestClass)]: {
        injectable: true,
        constructorParams: [
            { type: ChildClassTestClass1 },
            { type: ChildClassTestClass2 },
            { type: ProviderTestClass1, inject: 'custom-provider-1' },
            { type: ProviderTestClass2 },
        ],
        provide: createProvideRegistry(
            [ProviderTestClass2, () => new ProviderTestClass2('custom by type')],
            ['custom-provider-1', () => new ProviderTestClass1('custom by string')],
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
        provide: createProvideRegistry([ProviderTestClass2, () => new ProviderTestClass2('custom for child')]),
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
}

interface TMeta {
    resolve?: (v: unknown) => unknown,
    propList?: (string)[]
}

const options: TInfactOptions<TMeta, TMeta, Empty> = {
    describeClass: c => {
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
        const c2 = await infact.getForInstance(parent.child1, ProviderTestClass2)
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
        await expect(async () => await infact.get(RequiredInject)).rejects.
            toMatchInlineSnapshot('[Error: Could not inject "required-inject" argument with index 0]')
    })
})
