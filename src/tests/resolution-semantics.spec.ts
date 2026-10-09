/**
 * Pins the observable resolution semantics of `Infact.get()` — concurrency,
 * circular deps, error wrapping, provide/replace precedence, scopes, hooks
 * and instance-registry stamping — independently of how the resolution is
 * scheduled internally (sync or async).
 */
import {
    Infact,
    TInfactClassMeta,
    TInfactOptions,
    createProvideRegistry,
    createReplaceRegistry,
} from '..'
import { TAny } from '../types'

type TMeta = Partial<TInfactClassMeta<TAny>> & Record<string | symbol, TAny>
type TEvent = [string, string, string, unknown[] | undefined, unknown]

function nameOf(v: unknown): unknown {
    if (v && typeof v === 'object') {
        return Object.getPrototypeOf(v)?.constructor?.name
    }
    return v
}

function setup(opts: Partial<TInfactOptions<TAny, TAny, TAny, TAny>> = {}) {
    const meta = new Map<unknown, TMeta>()
    const events: TEvent[] = []
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
        on: (event, target, message, args, detail) => {
            events.push([
                event,
                target.name,
                message,
                args &&
                    (event === 'new-instance' ? args.map(nameOf) : [...args]),
                detail,
            ])
        },
        ...opts,
    })
    return { infact, meta, events }
}

const tick = () => new Promise((r) => setTimeout(r, 1))

describe('get() contract', () => {
    it('always returns a Promise, also for fully synchronous resolution', async () => {
        const { infact, meta } = setup()
        class A {}
        meta.set(A, {})
        const p = infact.get(A)
        expect(p).toBeInstanceOf(Promise)
        expect(await p).toBeInstanceOf(A)
        // cached hit
        const p2 = infact.get(A)
        expect(p2).toBeInstanceOf(Promise)
        expect(await p2).toBe(await p)
    })

    it('reports synchronous failures as rejections, never as throws', async () => {
        const { infact } = setup({
            describeClass: () => {
                throw new Error('boom')
            },
        })
        class A {}
        let p: Promise<unknown> | undefined
        expect(() => {
            p = infact.get(A)
        }).not.toThrow()
        await expect(p).rejects.toThrow(
            'An error occurred on "describeClass" function: boom',
        )
    })

    it('resolves optional non-injectable to undefined', async () => {
        const { infact } = setup()
        class A {}
        expect(await infact.get(A, undefined, true)).toBeUndefined()
    })

    it('passes a Promise-returning instantiate to resolveParam/resolveProp', async () => {
        const seen: unknown[] = []
        class Dep {}
        class A {
            p?: unknown
            constructor(public d: unknown) {}
        }
        const { infact, meta } = setup({
            resolveParam: ({ instantiate }) => {
                const r = instantiate(Dep)
                seen.push(r)
                return r
            },
            describeProp: () => ({}),
            resolveProp: ({ instantiate }) => {
                const r = instantiate(Dep)
                seen.push(r)
                return r
            },
        })
        meta.set(Dep, {})
        meta.set(A, {
            constructorParams: [{ type: undefined, label: 'd' }],
            properties: ['p'],
        })
        const a = await infact.get(A)
        expect(seen).toHaveLength(2)
        expect(seen[0]).toBeInstanceOf(Promise)
        expect(seen[1]).toBeInstanceOf(Promise)
        expect(a.d).toBeInstanceOf(Dep)
        expect(a.p).toBe(a.d)
    })
})

describe('concurrency', () => {
    it('two concurrent gets of a singleton with sync deps yield one instance', async () => {
        const { infact, meta } = setup()
        let created = 0
        class Dep {}
        class A {
            constructor(public d: Dep) {
                created++
            }
        }
        meta.set(Dep, {})
        meta.set(A, { constructorParams: [{ type: Dep }] })
        const [a, b] = await Promise.all([infact.get(A), infact.get(A)])
        expect(a).toBe(b)
        expect(created).toBe(1)
    })

    it('two concurrent gets of a singleton with async deps yield one instance', async () => {
        let created = 0
        class Dep {}
        class A {
            constructor(
                public v: unknown,
                public d: Dep,
            ) {
                created++
            }
        }
        const { infact, meta } = setup({
            resolveParam: ({ index }) =>
                index === 0 ? tick().then(() => 'async') : undefined,
        })
        meta.set(Dep, {})
        meta.set(A, { constructorParams: [{ type: String }, { type: Dep }] })
        const [a, b, c] = await Promise.all([
            infact.get(A),
            infact.get(A),
            infact.get(A),
        ])
        expect(a).toBe(b)
        expect(a).toBe(c)
        expect(created).toBe(1)
        expect(a.v).toBe('async')
        expect(a.d).toBeInstanceOf(Dep)
    })

    it('concurrent gets of a failing async creation all reject; a later get retries', async () => {
        let attempt = 0
        let created = 0
        class A {
            constructor(public v: unknown) {
                created++
            }
        }
        const { infact, meta } = setup({
            resolveParam: () => {
                attempt++
                return attempt === 1
                    ? tick().then(() => {
                          throw new Error('async fail')
                      })
                    : 'ok'
            },
        })
        meta.set(A, { constructorParams: [{ type: String, label: 'v' }] })
        const results = await Promise.allSettled([infact.get(A), infact.get(A)])
        expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
        const reasons = results.map((r) => (r as PromiseRejectedResult).reason)
        expect(reasons[0]).toBe(reasons[1])
        expect(reasons[0].message).toBe('async fail')
        expect(attempt).toBe(1)
        const a = await infact.get(A)
        expect(a.v).toBe('ok')
        expect(created).toBe(1)
    })

    it('a get re-entered during async creation waits for the same instance', async () => {
        class A {
            constructor(public v: unknown) {}
        }
        let inner: Promise<unknown> | undefined
        const { infact, meta } = setup({
            resolveParam: () => {
                inner = infact.get(A)
                return tick().then(() => 1)
            },
        })
        meta.set(A, { constructorParams: [{ type: Number }] })
        const a = await infact.get(A)
        expect(await inner).toBe(a)
    })

    it('exposes a Promise placeholder in the registry while a creation is suspended', async () => {
        class A {
            constructor(public v: unknown) {}
        }
        let release!: (v: unknown) => void
        const { infact, meta } = setup({
            resolveParam: () => new Promise((r) => (release = r)),
        })
        meta.set(A, { constructorParams: [{ type: Number }] })
        const p = infact.get(A)
        const registry = (infact as TAny).registry as Record<symbol, unknown>
        const [key] = Object.getOwnPropertySymbols(registry)
        expect(registry[key]).toBeInstanceOf(Promise)
        release(7)
        const a = await p
        expect(registry[key]).toBe(a)
        expect(a.v).toBe(7)
    })

    it('a get re-entered during synchronous creation resolves to the same instance', async () => {
        class A {
            p?: unknown
        }
        let inner: Promise<unknown> | undefined
        const { infact, meta } = setup({
            describeProp: () => ({}),
            resolveProp: ({ instantiate }) => {
                // fire-and-forget re-entrant resolution of the class being created
                inner = instantiate(A)
                return 'x'
            },
        })
        meta.set(A, { properties: ['p'] })
        const a = await infact.get(A)
        expect(a.p).toBe('x')
        expect(await inner).toBe(a)
    })

    it('a get re-entered during a failing synchronous creation rejects with the same error', async () => {
        let attempt = 0
        class A {
            p?: unknown
        }
        let inner: Promise<unknown> | undefined
        const { infact, meta } = setup({
            describeProp: () => ({}),
            resolveProp: ({ instantiate }) => {
                attempt++
                if (attempt === 1) {
                    inner = instantiate(A)
                    inner.catch(() => {})
                    throw new Error('prop fail')
                }
                return 'ok'
            },
        })
        meta.set(A, { properties: ['p'] })
        const err = await infact.get(A).catch((e: Error) => e)
        expect((err as Error).message).toBe('prop fail')
        await expect(inner).rejects.toBe(err)
        expect((await infact.get(A)).p).toBe('ok')
    })
})

describe('circular dependencies', () => {
    it('wires circular deps inside a scope and per scope', async () => {
        let scope = 's1'
        const { infact, meta } = setup()
        class A {
            constructor(public b: TAny) {}
        }
        class B {
            constructor(public a: TAny) {}
        }
        meta.set(A, {
            get scopeId() {
                return scope
            },
            constructorParams: [{ type: undefined, circular: () => B }],
        })
        meta.set(B, {
            get scopeId() {
                return scope
            },
            constructorParams: [{ type: undefined, circular: () => A }],
        })
        infact.registerScope('s1')
        const a1 = await infact.get(A)
        expect(a1.b.a).toBe(a1)
        expect(a1).toBeInstanceOf(A)
        expect(a1.b).toBeInstanceOf(B)
        scope = 's2'
        infact.registerScope('s2')
        const a2 = await infact.get(A)
        expect(a2).not.toBe(a1)
        expect(a2.b.a).toBe(a2)
        expect(await infact.get(B)).toBe(a2.b)
    })

    it('wires circular deps when another param resolves asynchronously', async () => {
        class A {
            constructor(
                public b: TAny,
                public v: unknown,
            ) {}
        }
        class B {
            constructor(public a: TAny) {}
        }
        const { infact, meta } = setup({
            resolveParam: ({ paramMeta }) =>
                paramMeta.type === String ? tick().then(() => 'v') : undefined,
        })
        meta.set(A, {
            constructorParams: [
                { type: undefined, circular: () => B },
                { type: String },
            ],
        })
        meta.set(B, {
            constructorParams: [{ type: undefined, circular: () => A }],
        })
        const a = await infact.get(A)
        expect(a.b.a).toBe(a)
        expect(a.v).toBe('v')
        expect(await infact.get(B)).toBe(a.b)
    })
})

describe('error wrapping', () => {
    it('reports a failing dependency, still resolves later siblings, keeps hierarchy', async () => {
        const { infact, meta, events } = setup()
        class Bad {}
        class Good {}
        class Consumer {
            constructor(
                public bad: Bad,
                public good: Good,
            ) {}
        }
        meta.set(Good, {})
        meta.set(Consumer, {
            constructorParams: [{ type: Bad, label: 'bad' }, { type: Good }],
        })
        const err = await infact.get(Consumer).catch((e: Error) => e)
        expect((err as Error).message).toBe(
            'Class is not Injectable and not Optional.',
        )
        expect(events).toEqual([
            [
                'error',
                'Bad',
                'Class is not Injectable and not Optional.',
                ['Consumer', 'Bad'],
                { hierarchy: ['Consumer', 'Bad'] },
            ],
            ['new-instance', 'Good', '', [], undefined],
            [
                'error',
                'Consumer',
                'Could not inject "Bad" argument at index 0 (bad). An exception occurred.',
                ['Consumer', 'Bad'],
                {
                    paramIndex: 0,
                    paramLabel: 'bad',
                    paramTypeName: 'Bad',
                    injectToken: undefined,
                    hierarchy: ['Consumer', 'Bad'],
                },
            ],
        ])
        // the consumer was not cached — a fixed dependency now resolves
        meta.set(Bad, {})
        const c = await infact.get(Consumer)
        expect(c.bad).toBeInstanceOf(Bad)
        expect(c.good).toBe(await infact.get(Good))
    })

    it('reports a deep dependency failure on every level', async () => {
        const { infact, meta, events } = setup()
        class Bad {}
        class Mid {
            constructor(public bad: Bad) {}
        }
        class Top {
            constructor(public mid: Mid) {}
        }
        meta.set(Mid, { constructorParams: [{ type: Bad }] })
        meta.set(Top, { constructorParams: [{ type: Mid }] })
        await expect(infact.get(Top)).rejects.toThrow(
            'Class is not Injectable and not Optional.',
        )
        expect(events.map((e) => [e[1], e[2], e[4]])).toEqual([
            [
                'Bad',
                'Class is not Injectable and not Optional.',
                { hierarchy: ['Top', 'Mid', 'Bad'] },
            ],
            [
                'Mid',
                'Could not inject "Bad" argument at index 0. An exception occurred.',
                {
                    paramIndex: 0,
                    paramLabel: undefined,
                    paramTypeName: 'Bad',
                    injectToken: undefined,
                    hierarchy: ['Top', 'Mid', 'Bad'],
                },
            ],
            [
                'Top',
                'Could not inject "Mid" argument at index 0. An exception occurred.',
                {
                    paramIndex: 0,
                    paramLabel: undefined,
                    paramTypeName: 'Mid',
                    injectToken: undefined,
                    hierarchy: ['Top', 'Mid', 'Bad'],
                },
            ],
        ])
    })

    it('wraps an async resolveParam rejection and rethrows the original error', async () => {
        const original = new Error('param rejected')
        class A {
            constructor(public v: unknown) {}
        }
        const { infact, meta, events } = setup({
            resolveParam: () => Promise.reject(original),
        })
        meta.set(A, { constructorParams: [{ type: String, label: 'v' }] })
        const err = await infact.get(A).catch((e: unknown) => e)
        expect(err).toBe(original)
        expect(events).toEqual([
            [
                'error',
                'A',
                'Could not inject "String" argument at index 0 (v). An exception occurred.',
                ['A'],
                {
                    paramIndex: 0,
                    paramLabel: 'v',
                    paramTypeName: 'String',
                    injectToken: undefined,
                    hierarchy: ['A'],
                },
            ],
        ])
    })

    it('propagates a synchronous resolveParam throw unwrapped and retries later', async () => {
        let attempt = 0
        class A {
            constructor(public v: unknown) {}
        }
        const { infact, meta, events } = setup({
            resolveParam: () => {
                attempt++
                if (attempt === 1) throw new Error('sync param fail')
                return 'ok'
            },
        })
        meta.set(A, { constructorParams: [{ type: String }] })
        await expect(infact.get(A)).rejects.toThrow('sync param fail')
        expect(events).toEqual([])
        expect((await infact.get(A)).v).toBe('ok')
    })

    it('propagates a constructor throw and retries later', async () => {
        let attempt = 0
        class A {
            constructor() {
                attempt++
                if (attempt === 1) throw new Error('ctor fail')
            }
        }
        const { infact, meta } = setup()
        meta.set(A, {})
        await expect(infact.get(A)).rejects.toThrow('ctor fail')
        expect(await infact.get(A)).toBeInstanceOf(A)
    })

    it('wraps prop failures (sync throw, async rejection, describeProp throw)', async () => {
        class A {
            p?: unknown
        }
        let mode = 'sync'
        const { infact, meta, events } = setup({
            describeProp: () => {
                if (mode === 'describe') throw new Error('describe fail')
                return {}
            },
            resolveProp: () => {
                if (mode === 'sync') throw new Error('sync prop')
                return Promise.reject(new Error('async prop'))
            },
        })
        meta.set(A, { properties: ['p'] })
        await expect(infact.get(A)).rejects.toThrow('sync prop')
        mode = 'async'
        await expect(infact.get(A)).rejects.toThrow('async prop')
        mode = 'describe'
        await expect(infact.get(A)).rejects.toThrow('describe fail')
        expect(events.map((e) => e[2])).toEqual([
            'Could not inject prop "p". An exception occurred: sync prop',
            'Could not inject prop "p". An exception occurred: async prop',
            'Could not process prop "p". An error occurred on "describeProp" function.\ndescribe fail',
        ])
    })

    it('rejects an unresolved primitive param', async () => {
        class A {
            constructor(public v: string) {}
        }
        const { infact, meta } = setup({ resolveParam: () => undefined })
        meta.set(A, { constructorParams: [{ type: String, label: 'v' }] })
        await expect(infact.get(A)).rejects.toThrow(
            'Could not inject "String" argument at index 0 (v). The param was not resolved to a value.',
        )
    })

    it('warns about an untyped, unresolved param', async () => {
        class A {
            constructor(public v: unknown) {}
        }
        const { infact, meta, events } = setup()
        meta.set(A, { constructorParams: [{ type: undefined }] })
        const a = await infact.get(A)
        expect(a.v).toBeUndefined()
        expect(events[0][0]).toBe('warn')
        expect(events[0][2]).toContain(
            'constructor() expects argument #0 that is undefined.',
        )
    })
})

describe('provide / replace precedence', () => {
    it('param.provide > class provide > get() provide', async () => {
        class Svc {
            constructor(public from: string) {}
        }
        class A {
            constructor(
                public plain: Svc,
                public overridden: Svc,
            ) {}
        }
        class B {
            constructor(public svc: Svc) {}
        }
        const { infact, meta } = setup()
        meta.set(Svc, {})
        meta.set(A, {
            provide: createProvideRegistry([Svc, () => new Svc('class')]),
            constructorParams: [
                { type: Svc },
                {
                    type: Svc,
                    provide: createProvideRegistry([
                        Svc,
                        () => new Svc('param'),
                    ]),
                },
            ],
        })
        meta.set(B, { constructorParams: [{ type: Svc }] })
        const provide = createProvideRegistry([Svc, () => new Svc('get')])
        const a = await infact.get(A, { provide })
        expect(a.plain.from).toBe('class')
        expect(a.overridden.from).toBe('param')
        const b = await infact.get(B, { provide })
        expect(b.svc.from).toBe('get')
    })

    it('resolves sync and async provide factories (class and string tokens)', async () => {
        class NotInjectable {
            constructor(public v: string) {}
        }
        class A {
            constructor(
                public n: NotInjectable,
                public s: unknown,
                public as: unknown,
                public missing: unknown,
            ) {}
        }
        const { infact, meta } = setup()
        meta.set(A, {
            constructorParams: [
                { type: NotInjectable },
                { type: String, inject: 'sync-token' },
                { type: String, inject: 'async-token' },
                { type: String, inject: 'missing-token', optional: true },
            ],
        })
        const provide = createProvideRegistry(
            [NotInjectable, async () => new NotInjectable('async-class')],
            ['sync-token', () => 'sync'],
            ['async-token', async () => 'async'],
        )
        const a = await infact.get(A, { provide })
        expect(a.n.v).toBe('async-class')
        expect(a.s).toBe('sync')
        expect(a.as).toBe('async')
        expect(a.missing).toBeUndefined()
        expect(await infact.get(NotInjectable, { provide })).toBe(a.n)
    })

    it('applies replace to nested deps using the replacement metadata', async () => {
        class Base {}
        class Dep {}
        class Repl extends Base {
            constructor(public dep: Dep) {
                super()
            }
        }
        class A {
            constructor(public b: Base) {}
        }
        const { infact, meta } = setup()
        meta.set(Dep, {})
        meta.set(Base, {})
        meta.set(Repl, { constructorParams: [{ type: Dep }] })
        meta.set(A, { constructorParams: [{ type: Base }] })
        const replace = createReplaceRegistry([Base, Repl])
        const a = await infact.get(A, { replace })
        expect(a.b).toBeInstanceOf(Repl)
        expect((a.b as Repl).dep).toBeInstanceOf(Dep)
        expect(await infact.get(Base, { replace })).toBe(a.b)
        expect(await infact.get(Base)).not.toBe(a.b)
    })
})

describe('scopes', () => {
    it('shares singletons across scopes and isolates scoped classes', async () => {
        let scope = 'e1'
        class Singleton {}
        class PerEvent {}
        class Ctrl {
            constructor(
                public pe: PerEvent,
                public s: Singleton,
            ) {}
        }
        const { infact, meta } = setup()
        meta.set(Singleton, {})
        meta.set(PerEvent, {
            get scopeId() {
                return scope
            },
        })
        meta.set(Ctrl, {
            get scopeId() {
                return scope
            },
            constructorParams: [{ type: PerEvent }, { type: Singleton }],
        })
        infact.registerScope('e1')
        const c1 = await infact.get(Ctrl)
        expect(await infact.get(Ctrl)).toBe(c1)
        expect(await infact.get(PerEvent)).toBe(c1.pe)
        scope = 'e2'
        infact.registerScope('e2')
        const c2 = await infact.get(Ctrl)
        expect(c2).not.toBe(c1)
        expect(c2.pe).not.toBe(c1.pe)
        expect(c2.s).toBe(c1.s)
        infact.unregisterScope('e1')
        infact.unregisterScope('e2')
        await expect(infact.get(Ctrl)).rejects.toThrow(
            'The requested scope "e2" isn\'t registered.',
        )
    })

    it('resolves a param from the scope named by param.fromScope', async () => {
        class Svc {}
        class A {
            constructor(public s: Svc) {}
        }
        const { infact, meta, events } = setup()
        meta.set(Svc, {})
        meta.set(A, { constructorParams: [{ type: Svc, fromScope: 'x' }] })
        await expect(infact.get(A)).rejects.toThrow(
            'The requested scope "x" isn\'t registered.',
        )
        expect(events[0][4]).toEqual({ hierarchy: ['A', 'Svc'] })
        infact.registerScope('x')
        const a = await infact.get(A)
        expect(a.s).not.toBe(await infact.get(Svc))
        expect(a.s).toBe(await infact.get(Svc, { fromScope: 'x' }))
    })
})

describe('hooks', () => {
    it('emits new-instance leaf-first with resolved args', async () => {
        class L1 {}
        class L2 {}
        class Mid {
            constructor(public l: L1) {}
        }
        class Top {
            constructor(
                public m: Mid,
                public l: L2,
            ) {}
        }
        const { infact, meta, events } = setup()
        meta.set(L1, {})
        meta.set(L2, {})
        meta.set(Mid, { constructorParams: [{ type: L1 }] })
        meta.set(Top, { constructorParams: [{ type: Mid }, { type: L2 }] })
        await infact.get(Top)
        // every instance is announced after its own dependencies; the order
        // of independent siblings (Mid's subtree vs L2) is not part of the
        // contract
        expect(events).toHaveLength(4)
        const at = (name: string) => events.findIndex((e) => e[1] === name)
        expect(at('L1')).toBeLessThan(at('Mid'))
        expect(at('Mid')).toBeLessThan(at('Top'))
        expect(at('L2')).toBeLessThan(at('Top'))
        expect(events[at('L1')]).toEqual([
            'new-instance',
            'L1',
            '',
            [],
            undefined,
        ])
        expect(events[at('Mid')]).toEqual([
            'new-instance',
            'Mid',
            '',
            ['L1'],
            undefined,
        ])
        expect(events[at('L2')]).toEqual([
            'new-instance',
            'L2',
            '',
            [],
            undefined,
        ])
        expect(events[3]).toEqual([
            'new-instance',
            'Top',
            '',
            ['Mid', 'L2'],
            undefined,
        ])
        events.length = 0
        await infact.get(Top)
        expect(events).toEqual([])
    })

    it('calls syncContextFn in a stable order (sync and async trees)', async () => {
        class L1 {}
        class L2 {
            constructor(public v: unknown) {}
        }
        class Top {
            constructor(
                public a: L1,
                public b: L2,
            ) {}
        }
        let asyncParam = false
        const { infact, meta } = setup({
            resolveParam: ({ paramMeta }) =>
                paramMeta.type === String
                    ? asyncParam
                        ? Promise.resolve('a')
                        : 's'
                    : undefined,
        })
        meta.set(L1, {})
        meta.set(L2, { constructorParams: [{ type: String }] })
        meta.set(Top, { constructorParams: [{ type: L1 }, { type: L2 }] })
        const calls: unknown[] = []
        const metaName = new Map<unknown, string>()
        const syncContextFn = (m?: unknown) => calls.push(metaName.get(m))
        const origDescribe = (infact as TAny).options.describeClass
        ;(infact as TAny).options.describeClass = (c: TAny) => {
            const m = origDescribe(c)
            metaName.set(m, c.name)
            return m
        }
        await infact.get(Top, { syncContextFn })
        expect(calls).toEqual(['L1', 'L2', 'Top', 'Top', 'Top'])
        calls.length = 0
        await infact.get(Top, { syncContextFn })
        expect(calls).toEqual(['Top'])
        infact._cleanup()
        asyncParam = true
        calls.length = 0
        await infact.get(Top, { syncContextFn })
        // with an async step the interleaving follows promise scheduling;
        // only the multiset of calls and the final call are stable
        expect([...calls].sort()).toEqual([
            'L1',
            'L2',
            'L2',
            'Top',
            'Top',
            'Top',
        ])
        expect(calls[0]).toBe('L1')
        expect(calls.at(-1)).toBe('Top')
    })
})

describe('instance registries', () => {
    it('stamps nested deps with the provide/replace/customData of their resolution', async () => {
        class Leaf {}
        class Dep {}
        class A {
            constructor(public d: Dep) {}
        }
        const { infact, meta } = setup()
        meta.set(Leaf, {})
        meta.set(Dep, {})
        const classProvide = createProvideRegistry(['t', () => 1])
        meta.set(A, {
            provide: classProvide,
            constructorParams: [{ type: Dep }],
        })
        const provide = createProvideRegistry(['g', () => 2])
        const replace = createReplaceRegistry()
        const customData = { c: 1 }
        const a = await infact.get(A, { provide, replace, customData })
        const regA = infact.getInstanceRegistries(a)
        expect(Object.keys(regA.provide!)).toEqual(['g', 't'])
        expect(regA.replace).toBe(replace)
        expect(regA.customData).toBe(customData)
        const regD = infact.getInstanceRegistries(a.d)
        expect(regD.provide).toBe(regA.provide)
        expect(regD.customData).toBe(customData)
        const leaf = await infact.getForInstance(a.d, Leaf)
        expect(infact.getInstanceRegistries(leaf).provide).toBe(regA.provide)
    })

    it('keeps the stamp when re-resolved with identical registries, updates it otherwise', async () => {
        class A {}
        const { infact, meta } = setup()
        meta.set(A, {})
        const provide = createProvideRegistry()
        const replace = createReplaceRegistry()
        const customData = { c: 1 }
        const a = await infact.get(A, { provide, replace, customData })
        const stamp = infact.getInstanceRegistries(a)
        await infact.get(A, { provide, replace, customData })
        expect(infact.getInstanceRegistries(a)).toBe(stamp)

        const customData2 = { c: 2 }
        await infact.get(A, { provide, replace, customData: customData2 })
        expect(infact.getInstanceRegistries(a).customData).toBe(customData2)
        const provide2 = createProvideRegistry()
        await infact.get(A, {
            provide: provide2,
            replace,
            customData: customData2,
        })
        expect(infact.getInstanceRegistries(a).provide).toBe(provide2)
        await infact.get(A, { provide: provide2, customData: customData2 })
        expect(infact.getInstanceRegistries(a).replace).toBeUndefined()
        expect(infact.getInstanceRegistries(a).provide).toBe(provide2)
    })

    it('setInstanceRegistries skips identical refs and overwrites changed ones', () => {
        const { infact } = setup()
        const inst = {}
        const provide = createProvideRegistry()
        infact.setInstanceRegistries(inst, provide)
        const stamp = infact.getInstanceRegistries(inst)
        infact.setInstanceRegistries(inst, provide)
        expect(infact.getInstanceRegistries(inst)).toBe(stamp)
        const customData = {}
        infact.setInstanceRegistries(inst, provide, undefined, customData)
        expect(infact.getInstanceRegistries(inst)).not.toBe(stamp)
        expect(infact.getInstanceRegistries(inst).customData).toBe(customData)
    })
})
