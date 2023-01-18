/* istanbul ignore file */
import { logError } from './log'

export function panic(error: string) {
    if (error) logError(error)
    return new Error(error)
}
