/**
 * Adversarial resolution cases for `Infact.get()`: placeholders left behind,
 * unhandled rejections, scope teardown mid-resolution, many concurrent
 * waiters, re-entrancy through nested dependencies.
 */
import { Infact, TInfactClassMeta, TInfactOptions } from '..'
import { TAny } from '../types'

type TMeta = Partial<TInfactClassMeta<TAny>> & Record<string | symbol, TAny>

function setup(opts: Partial<TInfactOptions<TAny, TAny, TAny, TAny>> = {}) {
    const meta = new Map<unknown, TMeta>()
    const infact = new Infact<TAny, TAny, TAny, TAny>({
        describeClass: (c) => {
            const m = meta.get(c)
            return (
                m
                    ? { injectable: true, constructorParams: [], ...m }
                    : undefined
            ) as TAny
        },
        storeProvideRegByInstance: true,
        ...opts,
    })
    const registry = () => (infact as TAny).registry as Record<symbol, unknown>
    const scope = (id: string) =>
        (infact as TAny).scopes.get(id) as Record<symbol, unknown> | undefined
    return { infact, meta, registry, scope }
}

const tick = () => new Promise((r) => setTimeout(r, 1))

/** Collects unhandled rejections raised while `fn` runs (plus a few ticks). */
async function unhandledDuring(fn: () => Promise<void>) {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
        await fn()
        await tick()
        await tick()
    } finally {
        process.off('unhandledRejection', onUnhandled)
    }
    return seen
}

function values(reg: Record<symbol, unknown> | undefined) {
    return reg ? Object.getOwnPropertySymbols(reg).map((k) => reg[k]) : []
}

describe('no placeholders left behind', () => {
    it('registry holds only instances after sync, async and failed creations', async () => {
        class Dep {}
        class SyncA {
            constructor(public d: Dep) {}
        }
        class AsyncA {
            constructor(public v: unknown) {}
        }
        class Failing {
            constructor() {
                throw new Error('ctor')
            }
        }
        class FailingAsync {
            constructor(public v: unknown) {}
        }
        const { infact, meta, registry } = setup({
            resolveParam: ({ classConstructor }) =>
                classConstructor === AsyncA
                    ? tick().then(() => 1)
                    : classConstructor === FailingAsync
                      ? tick().then(() => {
                            throw new Error('async')
                        })
                      : undefined,
        })
        meta.set(Dep, {})
        meta.set(SyncA, { constructorParams: [{ type: Dep }] })
        meta.set(AsyncA, { constructorParams: [{ type: Number }] })
        meta.set(Failing, {})
        meta.set(FailingAsync, { constructorParams: [{ type: Number }] })
        await infact.get(SyncA)
        await infact.get(AsyncA)
        await infact.get(Failing).catch(() => {})
        await Promise.allSettled([
            infact.get(FailingAsync),
            infact.get(FailingAsync),
        ])
        const held = values(registry())
        expect(held.map((v) => (v as object).constructor.name).sort()).toEqual([
            'AsyncA',
            'Dep',
            'SyncA',
        ])
        for (const v of held) {
            expect(typeof (v as { then?: unknown }).then).toBe('undefined')
        }
    })

    it('scoped registry holds only instances after resolution', async () => {
        class S {
            constructor(public v: unknown) {}
        }
        const { infact, meta, scope } = setup({
            resolveParam: () => tick().then(() => 'v'),
        })
        meta.set(S, { scopeId: 's', constructorParams: [{ type: String }] })
        infact.registerScope('s')
        const [a, b] = await Promise.all([infact.get(S), infact.get(S)])
        expect(a).toBe(b)
        expect(values(scope('s'))).toEqual([a])
    })
})

describe('unhandled rejections', () => {
    it('a failing sync creation nobody else waits on', async () => {
        class A {
            constructor() {
                throw new Error('ctor')
            }
        }
        const { infact, meta } = setup()
        meta.set(A, {})
        const seen = await unhandledDuring(async () => {
            await expect(infact.get(A)).rejects.toThrow('ctor')
        })
        expect(seen).toEqual([])
    })

    it('a failing async creation with several waiters', async () => {
        class A {
            constructor(public v: unknown) {}
        }
        const { infact, meta } = setup({
            resolveParam: () =>
                tick().then(() => {
                    throw new Error('async')
                }),
        })
        meta.set(A, { constructorParams: [{ type: String }] })
        const seen = await unhandledDuring(async () => {
            const r = await Promise.allSettled([
                infact.get(A),
                infact.get(A),
                infact.get(A),
            ])
            expect(r.every((x) => x.status === 'rejected')).toBe(true)
        })
        expect(seen).toEqual([])
    })

    it('a failing nested dependency (sync and async) under a parent', async () => {
        class Bad {
            constructor(public v: unknown) {}
        }
        class Ok {}
        class Parent {
            constructor(
                public ok: Ok,
                public bad: Bad,
            ) {}
        }
        let asyncFail = false
        const { infact, meta } = setup({
            resolveParam: ({ classConstructor }) => {
                if (classConstructor !== Bad) return undefined
                if (asyncFail) return Promise.reject(new Error('bad async'))
                throw new Error('bad sync')
            },
        })
        meta.set(Ok, {})
        meta.set(Bad, { constructorParams: [{ type: String }] })
        meta.set(Parent, { constructorParams: [{ type: Ok }, { type: Bad }] })
        const seen = await unhandledDuring(async () => {
            await expect(infact.get(Parent)).rejects.toThrow('bad sync')
            asyncFail = true
            await expect(infact.get(Parent)).rejects.toThrow('bad async')
        })
        expect(seen).toEqual([])
    })

    it('a re-entrant waiter of a failing creation whose promise is awaited by the caller', async () => {
        class A {
            p?: unknown
        }
        let inner: Promise<unknown> | undefined
        const { infact, meta } = setup({
            describeProp: () => ({}),
            resolveProp: ({ instantiate }) => {
                inner = instantiate(A)
                throw new Error('prop')
            },
        })
        meta.set(A, { properties: ['p'] })
        const seen = await unhandledDuring(async () => {
            await expect(infact.get(A)).rejects.toThrow('prop')
            await expect(inner).rejects.toThrow('prop')
        })
        expect(seen).toEqual([])
    })
})

describe('unhandled rejections of abandoned params/props', () => {
    it('a rejected dependency followed by a synchronous param failure', async () => {
        class Bad {}
        class P {
            constructor(
                public b: Bad,
                public s: string,
            ) {}
        }
        const { infact, meta } = setup({ resolveParam: () => undefined })
        meta.set(P, { constructorParams: [{ type: Bad }, { type: String }] })
        const seen = await unhandledDuring(async () => {
            await expect(infact.get(P)).rejects.toThrow(
                'Could not inject "String" argument at index 1. The param was not resolved to a value.',
            )
        })
        expect(seen).toEqual([])
    })

    it('a rejected resolveParam followed by a missing inject token', async () => {
        class P {
            constructor(
                public a: unknown,
                public b: unknown,
            ) {}
        }
        const { infact, meta } = setup({
            resolveParam: () => Promise.reject(new Error('rp')),
        })
        meta.set(P, {
            constructorParams: [{ type: String }, { inject: 'missing' }],
        })
        const seen = await unhandledDuring(async () => {
            await expect(infact.get(P)).rejects.toThrow(
                'Could not inject "missing" argument with index 1',
            )
        })
        expect(seen).toEqual([])
    })

    it('two failing dependencies (only the first is reported)', async () => {
        class Bad1 {}
        class Bad2 {}
        class P {
            constructor(
                public a: Bad1,
                public b: Bad2,
            ) {}
        }
        const { infact, meta } = setup()
        meta.set(P, { constructorParams: [{ type: Bad1 }, { type: Bad2 }] })
        const seen = await unhandledDuring(async () => {
            await expect(infact.get(P)).rejects.toThrow(
                'Class is not Injectable and not Optional.',
            )
        })
        expect(seen).toEqual([])
    })

    it('a rejected prop followed by a describeProp failure', async () => {
        class A {
            p1?: unknown
            p2?: unknown
        }
        const { infact, meta } = setup({
            describeProp: (_c, key) => {
                if (key === 'p2') throw new Error('describe fail')
                return {}
            },
            resolveProp: () => Promise.reject(new Error('prop rejected')),
        })
        meta.set(A, { properties: ['p1', 'p2'] })
        const seen = await unhandledDuring(async () => {
            await expect(infact.get(A)).rejects.toThrow('describe fail')
        })
        expect(seen).toEqual([])
    })
})

describe('concurrency and re-entrancy', () => {
    it('many concurrent gets of a singleton tree with async leaves create each class once', async () => {
        const created: string[] = []
        class Leaf {
            constructor(public v: unknown) {
                created.push('Leaf')
            }
        }
        class Mid {
            constructor(public leaf: Leaf) {
                created.push('Mid')
            }
        }
        class Top {
            constructor(
                public mid: Mid,
                public leaf: Leaf,
            ) {
                created.push('Top')
            }
        }
        const { infact, meta } = setup({
            resolveParam: ({ classConstructor }) =>
                classConstructor === Leaf ? tick().then(() => 'v') : undefined,
        })
        meta.set(Leaf, { constructorParams: [{ type: String }] })
        meta.set(Mid, { constructorParams: [{ type: Leaf }] })
        meta.set(Top, { constructorParams: [{ type: Mid }, { type: Leaf }] })
        const all = await Promise.all([
            ...Array.from({ length: 5 }, () => infact.get(Top)),
            infact.get(Mid),
            infact.get(Leaf),
        ])
        const top = all[0] as Top
        for (const t of all.slice(0, 5)) expect(t).toBe(top)
        expect(all[5]).toBe(top.mid)
        expect(all[6]).toBe(top.leaf)
        expect(top.mid.leaf).toBe(top.leaf)
        expect(created).toEqual(['Leaf', 'Mid', 'Top'])
    })

    it('a dependency re-entering its (synchronously created) parent gets the parent', async () => {
        class Child {
            v?: unknown
        }
        class Parent {
            constructor(public child: Child) {}
        }
        let inner: Promise<unknown> | undefined
        const { infact, meta } = setup({
            describeProp: () => ({}),
            resolveProp: ({ instantiate }) => {
                inner = instantiate(Parent)
                return 'x'
            },
        })
        meta.set(Child, { properties: ['v'] })
        meta.set(Parent, { constructorParams: [{ type: Child }] })
        const p = await infact.get(Parent)
        expect(p.child.v).toBe('x')
        expect(await inner).toBe(p)
    })

    it('a scope unregistered while a scoped creation is suspended still resolves', async () => {
        class S {
            constructor(public v: unknown) {}
        }
        let release!: (v: unknown) => void
        const { infact, meta, scope } = setup({
            resolveParam: () => new Promise((r) => (release = r)),
        })
        meta.set(S, { scopeId: 's', constructorParams: [{ type: Number }] })
        infact.registerScope('s')
        const p = infact.get(S)
        infact.unregisterScope('s')
        release(1)
        const s = await p
        expect(s).toBeInstanceOf(S)
        expect(scope('s')).toBeUndefined()
        await expect(infact.get(S)).rejects.toThrow(
            'The requested scope "s" isn\'t registered.',
        )
        infact.registerScope('s')
        release = undefined as TAny
        const next = infact.get(S)
        release(2)
        expect(await next).not.toBe(s)
    })

    it('a fromScope dependency of a singleton resolves in the named scope', async () => {
        class Dep {
            constructor(public v: unknown) {}
        }
        class Top {
            constructor(public dep: Dep) {}
        }
        let n = 0
        const { infact, meta, scope, registry } = setup({
            resolveParam: ({ classConstructor }) =>
                classConstructor === Dep
                    ? n++ % 2
                        ? tick().then(() => n)
                        : n
                    : undefined,
        })
        meta.set(Dep, { constructorParams: [{ type: Number }] })
        meta.set(Top, {
            constructorParams: [{ type: Dep, fromScope: 'req' }],
        })
        infact.registerScope('req')
        const top = await infact.get(Top)
        expect(values(scope('req'))).toEqual([top.dep])
        expect(values(registry())).toEqual([top])
        // a fresh scope gets a fresh dep (async leaf this time)
        infact.unregisterScope('req')
        infact.registerScope('req')
        expect(await infact.get(Dep, { fromScope: 'req' })).not.toBe(top.dep)
        expect(await infact.get(Top)).toBe(top)
    })
})
