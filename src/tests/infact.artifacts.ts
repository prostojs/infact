export class ProviderTestClass1 {
    constructor(public config: string) {}
}

export class ProviderTestClass2 {
    constructor(public config: string) {}
}

export class ChildClassTestClass1 {
    constructor(
        public provider1: ProviderTestClass1,
        public provider2: ProviderTestClass2,
    ) {}
}

export class ChildClassTestClass2 {
    constructor(
        public provider1: ProviderTestClass1,
        public provider2: ProviderTestClass2,
        public provider11: ProviderTestClass1,
        public provider12: ProviderTestClass1,
    ) {}
}

export class ParentTestClass {
    constructor(
        public child1: ChildClassTestClass1,
        public child2: ChildClassTestClass2,
        public provider1: ProviderTestClass1,
        public provider2: ProviderTestClass2,
    ) {}
}

export class WithProps {
    prop1?: string

    prop2: number = 5

    method() {
        //
    }

    propM = () => 'value'
}

export class OptionalInject {
    constructor(public data?: string) {}
}

export class RequiredInject {
    constructor(public data: string) {}
}

// For race condition test
export class SimpleDep {
    id = Math.random()
}
export class ServiceWithDep {
    constructor(public dep: SimpleDep) {}
}

// For replace test
export class OriginalService {
    type = 'original'
}
export class ReplacementService extends OriginalService {
    type = 'replacement'
}

// For global test
export class GlobalService {
    id = Math.random()
}

// For scope test
export class ScopedService {
    id = Math.random()
}

// For circular Object.assign test (non-enumerable property)
export class CircularNonEnum {
    hidden!: number
    constructor(public other: CircularNonEnumDep) {
        Object.defineProperty(this, 'hidden', {
            value: 42,
            enumerable: false,
            writable: true,
            configurable: true,
        })
    }
}
export class CircularNonEnumDep {
    constructor(public ref: CircularNonEnum) {}
}
