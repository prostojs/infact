# @prostojs/infact

**In**stance **Fact**ory — a zero-dependency, metadata-driven Dependency Injection container for TypeScript.

Infact is intentionally **decorator-agnostic**: you supply a `describeClass` callback that reads metadata however you choose (`Reflect.getMetadata`, a manual registry, code generation, etc.). Infact handles singleton caching, scoped lifecycles, circular dependencies, provider overrides, and class substitution.

## Install

```bash
npm install @prostojs/infact
```

## Quick Start

```ts
import { Infact, TInfactClassMeta } from '@prostojs/infact'

class Database {
    query(sql: string) { return sql }
}

class UserRepo {
    constructor(public db: Database) {}
}

// 1. Define metadata (however you like)
const meta: Record<string, TInfactClassMeta> = {
    Database:  { injectable: true, constructorParams: [] },
    UserRepo:  { injectable: true, constructorParams: [{ type: Database }] },
}

// 2. Create the container
const container = new Infact({
    describeClass: (cls) => meta[cls.name],
})

// 3. Resolve
const repo = await container.get(UserRepo)
repo.db.query('SELECT 1') // works — Database was auto-created
```

Every class is a **singleton** within its Infact instance by default. Calling `get(UserRepo)` twice returns the same object.

## Core Concepts

### Metadata via `describeClass`

Infact does not read decorators or reflect metadata on its own. Instead, you provide a `describeClass` function that returns an `TInfactClassMeta` object for any given class constructor:

```ts
interface TInfactClassMeta {
    injectable: boolean               // must be true to allow instantiation
    constructorParams: ParamMeta[]    // describes each constructor argument
    global?: boolean                  // share instance across all Infact containers
    scopeId?: string | symbol         // bind to a named scope
    provide?: TProvideRegistry        // override dependencies for this class subtree
    properties?: (string | symbol)[]  // instance properties to resolve after construction
}
```

### Constructor Parameters

Each entry in `constructorParams` tells Infact how to resolve one constructor argument:

```ts
interface TInfactConstructorParamMeta {
    type?: Function              // the class to instantiate (or String/Number/etc.)
    inject?: string | symbol     // resolve from provide registry by token instead of type
    circular?: () => Constructor // lazy ref for circular deps (type must be undefined)
    nullable?: boolean           // allow undefined when unresolvable
    optional?: boolean           // alias for nullable
    label?: string               // used in error messages
    fromScope?: string | symbol  // resolve this param from a specific scope
    provide?: TProvideRegistry   // extra provide overrides for this param subtree
}
```

### Singleton Tiers

Infact maintains three levels of singleton registries, checked in this order:

| Tier | Lifetime | Created by |
|------|----------|------------|
| **Scope** | Until `unregisterScope()` | `registerScope(id)` + `get(Cls, { fromScope: id })` |
| **Instance** | Per `Infact` instance | Default for all classes |
| **Global** | Cross-container (static) | `global: true` in class meta |

## API

### `new Infact(options)`

Creates a DI container. The full options interface:

```ts
interface TInfactOptions<Class, Prop, Param, Custom> {
    // Required — returns class metadata
    describeClass: (cls: Constructor) => TInfactClassMeta<Param> & Class

    // Optional — returns metadata for a specific instance property
    describeProp?: (cls: Constructor, key: string | symbol) => Prop

    // Optional — custom resolver for constructor params
    // Return a value to override default resolution, or undefined to fall through
    resolveParam?: (opts: {
        paramMeta, classMeta, classConstructor,
        index, scopeId, customData,
        instantiate: (cls) => Promise<instance>
    }) => unknown | Promise<unknown>

    // Optional — custom resolver for instance properties
    resolveProp?: (opts: {
        instance, key, initialValue, propMeta,
        classMeta, classConstructor, scopeId, customData,
        instantiate: (cls) => Promise<instance>
    }) => unknown | Promise<unknown>

    // Optional — store provide/replace context per instance (enables getForInstance)
    storeProvideRegByInstance?: boolean

    // Optional — lifecycle event listener
    on?: (event: 'new-instance' | 'warn' | 'error', targetClass, message, args?) => void
}
```

### `container.get(Class, opts?, optional?)`

Resolves a class asynchronously. Returns a `Promise<T>`.

```ts
const instance = await container.get(MyClass)
```

Options:

```ts
interface TInfactGetOptions {
    provide?: TProvideRegistry    // override providers for this resolution tree
    replace?: TReplaceRegistry    // substitute classes for this resolution tree
    customData?: object           // passed through to resolveParam / resolveProp
    fromScope?: string | symbol   // resolve from a named scope
    hierarchy?: string[]          // (internal) tracks resolution chain for error messages
}
```

### `container.getForInstance(instance, Class, opts?)`

Resolves `Class` using the same provide/replace context that was used to create `instance`. Requires `storeProvideRegByInstance: true`.

```ts
const container = new Infact({
    describeClass: (cls) => meta[cls.name],
    storeProvideRegByInstance: true,
})

const parent = await container.get(Parent)
// child inherits Parent's provide/replace overrides
const child = await container.getForInstance(parent, ChildDep)
```

### `container.registerScope(scopeId)` / `container.unregisterScope(scopeId)`

Creates or destroys a named scope. Scoped instances are isolated from the main registry and from other scopes:

```ts
container.registerScope('request-1')

const a = await container.get(Service, { fromScope: 'request-1' })
const b = await container.get(Service, { fromScope: 'request-1' })
a === b // true — singleton within scope

container.unregisterScope('request-1') // all scoped instances are discarded
```

### `container._cleanup()`

Resets the instance registry, instance-registry metadata, and all scopes. Useful for dev-mode hot reload.

### `Infact._cleanupGlobal()`

Static method. Clears the global (cross-container) singleton registry. Use with care.

### `createProvideRegistry(...entries)`

Builds a provide registry — a map of lazy factories keyed by class constructor or string token:

```ts
import { createProvideRegistry } from '@prostojs/infact'

const provide = createProvideRegistry(
    [DatabaseConnection, () => new DatabaseConnection('postgres://...')],
    ['API_KEY', () => process.env.API_KEY],
)
```

Providers are **lazy** — the factory runs once on first resolution and the result is cached.

### `createReplaceRegistry(...entries)`

Builds a replace registry — maps one class to another throughout a resolution tree:

```ts
import { createReplaceRegistry } from '@prostojs/infact'

const replace = createReplaceRegistry(
    [ProductionMailer, MockMailer],
)

const service = await container.get(NotificationService, { replace })
// NotificationService depends on ProductionMailer,
// but MockMailer will be instantiated instead
```

## Features

### Provide Overrides

Attach a provide registry to class metadata to override dependencies for that class and its entire subtree:

```ts
const meta = {
    AppController: {
        injectable: true,
        constructorParams: [{ type: AuthService }],
        provide: createProvideRegistry(
            [AuthService, () => new AuthService('jwt-secret')],
        ),
    },
    AuthService: {
        injectable: true,
        constructorParams: [],
    },
}
```

You can also pass `provide` per-param to scope overrides to a single branch:

```ts
constructorParams: [
    {
        type: RepoA,
        provide: createProvideRegistry(
            [DbPool, () => new DbPool('read-replica')],
        ),
    },
    { type: RepoB }, // uses default DbPool
]
```

Or pass `provide` at resolution time:

```ts
await container.get(AppController, {
    provide: createProvideRegistry(
        [Logger, () => new ConsoleLogger()],
    ),
})
```

Providers can be keyed by **string token** for non-class dependencies:

```ts
constructorParams: [
    { type: Object, inject: 'config', nullable: true },
]

// Somewhere upstream:
provide: createProvideRegistry(
    ['config', () => ({ port: 3000 })],
)
```

### Replace (Class Substitution)

Replace registries swap one class for another. The replacement class is instantiated using its own metadata:

```ts
const replace = createReplaceRegistry(
    [OriginalService, MockService],
)

const instance = await container.get(OriginalService, { replace })
instance instanceof MockService // true
```

### Circular Dependencies

When two classes depend on each other, mark the circular param with a lazy `circular` function and set `type` to `undefined`:

```ts
// A depends on B, B depends on A
const meta = {
    A: {
        injectable: true,
        constructorParams: [
            { type: undefined, circular: () => B },
        ],
    },
    B: {
        injectable: true,
        constructorParams: [
            { type: undefined, circular: () => A },
        ],
    },
}
```

Infact pre-creates a prototype-based shell object and fills it in after instantiation via `Object.defineProperties`, preserving non-enumerable properties.

### Scoped Instances

Scopes provide isolated singleton registries — useful for per-request lifecycles in servers:

```ts
container.registerScope('request-42')

const userService = await container.get(UserService, {
    fromScope: 'request-42',
})

// Later, discard all instances from that scope
container.unregisterScope('request-42')
```

A class can also declare its `scopeId` in metadata, so it always resolves from that scope without passing `fromScope` at call site.

**Note:** `global: true` and `scopeId` cannot be combined — this throws an error.

### Global Instances

Mark a class as `global: true` in its metadata to share a single instance across all `Infact` containers:

```ts
const meta = {
    ConfigService: {
        injectable: true,
        global: true,
        constructorParams: [],
    },
}

const containerA = new Infact({ describeClass: (cls) => meta[cls.name] })
const containerB = new Infact({ describeClass: (cls) => meta[cls.name] })

const a = await containerA.get(ConfigService)
const b = await containerB.get(ConfigService)
a === b // true
```

### Property Resolution

Infact can resolve instance properties after construction. List property keys in `properties` and provide `describeProp` + `resolveProp` callbacks:

```ts
class MyService {
    configValue?: string
    computedProp: number = 0
}

const container = new Infact({
    describeClass: () => ({
        injectable: true,
        constructorParams: [],
        properties: ['configValue', 'computedProp'],
    }),
    describeProp: (cls, key) => {
        // return property-level metadata
        return { transform: (v: number) => v * 2 }
    },
    resolveProp: ({ key, initialValue, propMeta }) => {
        if (key === 'configValue') return 'injected'
        if (propMeta.transform) return propMeta.transform(initialValue)
    },
})

const svc = await container.get(MyService)
svc.configValue   // 'injected'
svc.computedProp  // 0 (transform(0) = 0)
```

### Custom Param Resolution

The `resolveParam` callback lets you inject values that aren't class instances — environment variables, config objects, primitives:

```ts
const container = new Infact({
    describeClass: (cls) => meta[cls.name],
    resolveParam: ({ paramMeta, index }) => {
        // Inject all String-typed params with a resolved value
        if (paramMeta.type === String) {
            return 'injected-string'
        }
        // Return undefined to fall through to default resolution
    },
})
```

The callback also receives an `instantiate` helper for manually triggering resolution of other classes within the current context:

```ts
resolveParam: async ({ paramMeta, instantiate }) => {
    if (paramMeta.type === SomeAbstractClass) {
        return instantiate(ConcreteImplementation)
    }
}
```

### Event Listener

Monitor container activity via the `on` callback:

```ts
const container = new Infact({
    describeClass: (cls) => meta[cls.name],
    on(event, targetClass, message, args) {
        if (event === 'error') console.error(`DI error in ${targetClass.name}: ${message}`)
        if (event === 'warn') console.warn(`DI warning: ${message}`)
        if (event === 'new-instance') console.log(`Created ${targetClass.name}`)
    },
})
```

## Exported Types

```ts
import type {
    TInfactOptions,
    TInfactClassMeta,
    TInfactConstructorParamMeta,
    TInfactGetOptions,
    TProvideRegistry,
    TReplaceRegistry,
    TProvideFn,
} from '@prostojs/infact'
```

## License

MIT
