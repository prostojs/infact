import {
    Infact,
    TInfactClassMeta,
    createProvideRegistry,
    createReplaceRegistry,
    getClassKey,
} from '..'

type TCtor = new (...args: unknown[]) => object

let seq = 0
/** Every call returns a NEW class with the very same source text. */
const makeClass = (): TCtor =>
    class {
        id = ++seq
    }

const plain: TInfactClassMeta = { injectable: true, constructorParams: [] }

function newInfact(meta: Map<unknown, TInfactClassMeta>) {
    return new Infact({
        describeClass: (c) => meta.get(c) as TInfactClassMeta,
    })
}

describe('class keys', () => {
    it('must key identical-source classes apart, and a class the same every time', () => {
        const LoggerToken = class {}
        const UserToken = class {}
        expect(String(LoggerToken)).toBe(String(UserToken))

        expect(getClassKey(LoggerToken)).not.toBe(getClassKey(UserToken))
        expect(getClassKey(LoggerToken)).toBe(getClassKey(LoggerToken))
        expect(getClassKey(LoggerToken).description).toBe('LoggerToken')
    })

    it('must key the same class identically in every copy of the package', async () => {
        const Token = class {}
        const key = getClassKey(Token)
        vi.resetModules()
        const copy = await import('../class-key')
        expect(copy.getClassKey).not.toBe(getClassKey)
        expect(copy.getClassKey(Token)).toBe(key)
    })

    it('must resolve provided identical-source tokens independently', async () => {
        const LoggerToken = makeClass()
        const UserToken = makeClass()
        class Consumer {
            constructor(
                public logger: unknown,
                public user: unknown,
            ) {}
        }
        const meta = new Map<unknown, TInfactClassMeta>([
            [
                Consumer,
                {
                    injectable: true,
                    constructorParams: [
                        { type: LoggerToken },
                        { inject: getClassKey(UserToken) },
                    ],
                },
            ],
        ])
        const provide = createProvideRegistry(
            [LoggerToken, () => 'logger'],
            [UserToken, () => 'user'],
        )
        expect(Reflect.ownKeys(provide)).toHaveLength(2)
        const consumer = await newInfact(meta).get(Consumer, { provide })
        expect(consumer.logger).toBe('logger')
        expect(consumer.user).toBe('user')
    })

    it('must not replace an identical-source sibling of the replaced class', async () => {
        const LoggerService = makeClass()
        const UserService = makeClass()
        class RequestUser {}
        class Consumer {
            constructor(
                public logger: object,
                public user: object,
            ) {}
        }
        const meta = new Map<unknown, TInfactClassMeta>([
            [LoggerService, plain],
            [UserService, plain],
            [RequestUser, plain],
            [
                Consumer,
                {
                    injectable: true,
                    constructorParams: [
                        { type: LoggerService },
                        { type: UserService },
                    ],
                },
            ],
        ])
        const replace = createReplaceRegistry([UserService, RequestUser])
        expect(replace[getClassKey(LoggerService)]).toBeUndefined()
        const consumer = await newInfact(meta).get(Consumer, { replace })
        expect(consumer.logger).toBeInstanceOf(LoggerService)
        expect(consumer.user).toBeInstanceOf(RequestUser)
    })

    it('must keep one singleton per identical-source class', async () => {
        const A = makeClass()
        const B = makeClass()
        const infact = newInfact(
            new Map([
                [A, plain],
                [B, plain],
            ]),
        )
        const a1 = await infact.get(A)
        const b1 = await infact.get(B)
        expect(a1).toBeInstanceOf(A)
        expect(b1).toBeInstanceOf(B)
        expect(await infact.get(A)).toBe(a1)
        expect(await infact.get(B)).toBe(b1)
    })

    it('must keep scoped instances per identical-source class and per scope', async () => {
        const A = makeClass()
        const B = makeClass()
        const scoped = { ...plain, scopeId: 'ev' }
        const infact = newInfact(
            new Map([
                [A, scoped],
                [B, scoped],
            ]),
        )
        infact.registerScope('ev')
        const a1 = await infact.get(A)
        expect(await infact.get(B)).toBeInstanceOf(B)
        expect(await infact.get(A)).toBe(a1)
        infact.unregisterScope('ev')
        infact.registerScope('ev')
        const a2 = await infact.get(A)
        expect(a2).toBeInstanceOf(A)
        expect(a2).not.toBe(a1)
    })
})
