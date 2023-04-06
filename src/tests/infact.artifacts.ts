export class ProviderTestClass1 {
    constructor(
        public config: string
    ) {}
}

export class ProviderTestClass2 {
    constructor(
        public config: string
    ) {}
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
    constructor(
        public data?: string,
    ) {}
}

export class RequiredInject {
    constructor(
        public data: string,
    ) {}
}
