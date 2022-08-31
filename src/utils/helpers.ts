import { TFunction, TObject } from '../types'

export function getConstructor<T = TObject>(instance: T): TFunction {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return Object.getPrototypeOf(instance).constructor
}

