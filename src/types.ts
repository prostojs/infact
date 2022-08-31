/* eslint-disable @typescript-eslint/ban-types */
export type TAny = any
export type TObject = object
export type TFunction = Function
export type TClassConstructor<T = unknown> = new (...args : TAny[]) => T
