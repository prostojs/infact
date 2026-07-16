import { Infact, TInfactClassMeta, createProvideRegistry } from '..'
import { symbol } from './infact.artifacts'

class TokenConsumer {
    constructor(public value: unknown) {}
}

class DoubleTokenConsumer {
    constructor(
        public a: unknown,
        public b: unknown,
        public c: unknown,
    ) {}
}

class DbSpace {
    label = 'db-space'
}

class DefConsumer {
    constructor(
        public def: unknown,
        public space: DbSpace,
    ) {}
}

const meta: Record<symbol, TInfactClassMeta> = {
    [symbol(TokenConsumer)]: {
        injectable: true,
        constructorParams: [{ inject: 'MAIN' }],
    },
    [symbol(DoubleTokenConsumer)]: {
        injectable: true,
        constructorParams: [
            { inject: 'MAIN' },
            { inject: 'MAIN' },
            { inject: 'OTHER' },
        ],
    },
    [symbol(DbSpace)]: {
        injectable: true,
        constructorParams: [],
    },
    [symbol(DefConsumer)]: {
        injectable: true,
        constructorParams: [{ inject: 'READABLE_DEF' }, { type: DbSpace }],
    },
}

function newInfact() {
    return new Infact({
        describeClass: (c) => meta[symbol(c)],
    })
}

describe('resolver-aware provide factories', () => {
    it('must keep zero-arg factories working (backwards compat)', async () => {
        const provide = createProvideRegistry(['MAIN', () => 'zero-arg-value'])
        const c = await newInfact().get(TokenConsumer, { provide })
        expect(c.value).toBe('zero-arg-value')
    })

    it('must let a factory resolve another token via resolve()', async () => {
        const provide = createProvideRegistry(
            ['MAIN', (resolve) => `main:${resolve!('OTHER') as string}`],
            ['OTHER', () => 'other-value'],
        )
        const c = await newInfact().get(TokenConsumer, { provide })
        expect(c.value).toBe('main:other-value')
    })

    it('must memoize factories (each factory runs once)', async () => {
        let mainCalls = 0
        let otherCalls = 0
        const provide = createProvideRegistry(
            [
                'MAIN',
                (resolve) => {
                    mainCalls++
                    return `main:${resolve!('OTHER') as string}`
                },
            ],
            [
                'OTHER',
                () => {
                    otherCalls++
                    return 'other-value'
                },
            ],
        )
        const c = await newInfact().get(DoubleTokenConsumer, { provide })
        expect(c.a).toBe('main:other-value')
        expect(c.b).toBe('main:other-value')
        expect(c.c).toBe('other-value')
        expect(mainCalls).toBe(1)
        expect(otherCalls).toBe(1)
    })

    it('must resolve a class token provided via createProvideRegistry', async () => {
        const provide = createProvideRegistry(
            [DbSpace, () => new DbSpace()],
            ['READABLE_DEF', (resolve) => ({ space: resolve!(DbSpace) })],
        )
        const c = await newInfact().get(DefConsumer, { provide })
        expect((c.def as { space: DbSpace }).space).toBeInstanceOf(DbSpace)
        // the resolver returns the same memoized instance the container injects
        expect((c.def as { space: DbSpace }).space).toBe(c.space)
    })

    it('must throw a descriptive error for a missing token', async () => {
        const provide = createProvideRegistry([
            'MAIN',
            (resolve) => resolve!('MISSING'),
        ])
        await expect(
            newInfact().get(TokenConsumer, { provide }),
        ).rejects.toThrow(
            'Provide factory could not resolve token "MISSING": token is not in the provide registry.',
        )
    })

    it('must detect a direct cycle (A resolves A)', async () => {
        const provide = createProvideRegistry([
            'MAIN',
            (resolve) => resolve!('MAIN'),
        ])
        // the top-level factory is in-flight (`resolved` is set before `fn()`
        // runs), so re-entry is caught by the explicit in-flight marker
        await expect(
            newInfact().get(TokenConsumer, { provide }),
        ).rejects.toThrow(
            'Circular provide-factory resolution detected: MAIN → MAIN',
        )
    })

    it('must detect an indirect cycle through the top-level token (A → B → A)', async () => {
        const provide = createProvideRegistry(
            ['MAIN', (resolve) => resolve!('B')],
            ['B', (resolve) => resolve!('MAIN')],
        )
        await expect(
            newInfact().get(TokenConsumer, { provide }),
        ).rejects.toThrow(
            'Circular provide-factory resolution detected: MAIN → B → MAIN',
        )
    })

    it('must detect a cycle deeper in the resolver chain (entry → A → B → A)', async () => {
        const provide = createProvideRegistry(
            ['MAIN', (resolve) => resolve!('A')],
            ['A', (resolve) => resolve!('B')],
            ['B', (resolve) => resolve!('A')],
        )
        // MAIN is not part of the cycle and must not appear in the chain
        await expect(
            newInfact().get(TokenConsumer, { provide }),
        ).rejects.toThrow(
            'Circular provide-factory resolution detected: A → B → A',
        )
    })

    it('must return the raw promise when the resolved factory is async', async () => {
        let sawPromise = false
        const provide = createProvideRegistry(
            ['ASYNC', async () => 'async-value'],
            [
                'MAIN',
                (resolve) => {
                    const v = resolve!('ASYNC')
                    sawPromise =
                        typeof (v as Promise<unknown>).then === 'function'
                    return v
                },
            ],
        )
        const c = await newInfact().get(TokenConsumer, { provide })
        expect(sawPromise).toBe(true)
        // the injection call site awaits the value before injecting
        expect(c.value).toBe('async-value')
    })
})
