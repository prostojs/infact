import { CircularTestClass1 } from './circular1.artifacts'

export class CircularTestClass2 {
    constructor(public c1: CircularTestClass1, public str: string) {}
}
