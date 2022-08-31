import { CircularTestClass2 } from './circular2.artifacts'

export class CircularTestClass1 {
    constructor(public c2: CircularTestClass2) {}
}
