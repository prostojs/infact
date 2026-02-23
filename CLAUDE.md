# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@prostojs/infact` — a zero-dependency Instance Factory and Instance Registry for metadata-driven Dependency Injection. The name is a portmanteau: **In**stance **fact**ory. It is intentionally decorator-agnostic: callers supply a `describeClass` callback that reads metadata however they choose (e.g., `Reflect.getMetadata`, manual registry, etc.).

## Commands

```bash
pnpm test          # run tests
pnpm test:cov      # run tests with coverage
pnpm build         # rollup → dist/ (ESM, CJS, .d.ts)
pnpm lint          # oxlint (linter)
pnpm lint:fix      # oxlint --fix
pnpm fmt           # oxfmt (formatter)
pnpm fmt:check     # oxfmt --check (CI mode)
```

Run a single test by name:

```bash
npx vitest run -t "test name pattern"
```

## Architecture

The entire library lives in a single source file: `src/infact.ts` (~640 lines). There is no complex module graph.

**Main export:** `Infact<Class, Prop, Param, Custom>` — the generic DI container class with 4 type parameters for extensible metadata shapes.

**Key concepts:**

- **Singleton registries** — instances keyed by `Symbol.for(constructor)` at three tiers: global (static, cross-Infact), per-Infact-instance, per-scope
- **Provide registries** — `createProvideRegistry()` builds lazy-factory overrides for any dependency (by class constructor or string token)
- **Replace registries** — `createReplaceRegistry()` substitutes one class for another throughout a resolution tree
- **Circular dependency support** — params marked `circular: () => Class` get a pre-created prototype shell filled in after instantiation
- **Scoped instances** — `registerScope(scopeId)` / `unregisterScope(scopeId)` for isolated lifecycle management
- **Instance registry inheritance** — `getForInstance(existingInstance, ChildClass)` resolves using the same provide/replace context that created `existingInstance` (requires `storeProvideRegByInstance: true`)
- **Async resolution** — `get()` is async; `resolveParam` and `resolveProp` callbacks may return Promises

**Supporting files:**

- `src/types.ts` — shared primitive types (`TAny`, `TObject`, `TFunction`, `TClassConstructor`)
- `src/utils/helpers.ts` — `getConstructor()` utility
- `src/tests/` — Vitest specs and fixture classes (artifacts)

## Build System

Rollup produces three outputs from `src/index.ts`:

- `dist/index.mjs` (ESM), `dist/index.cjs` (CJS), `dist/index.d.ts` (declarations)

Compile-time replacements: `process.env.NODE_ENV` → `"production"`, all `__DYE_*__` color constants inlined as ANSI strings (no runtime `@prostojs/dye` dependency in output). Vitest config mirrors these globals for tests.

## Code Style

- 4-space indentation, single quotes, no semicolons, trailing commas on multiline
- Conventional commits enforced by git hook (`yorkie` + `scripts/verifyCommit.js`)
- Valid prefixes: `feat|fix|docs|dx|style|refactor|perf|test|workflow|build|ci|chore|types|wip|release`
