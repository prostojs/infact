import { ProstoLogger, coloredConsole, createConsoleTransort } from '@prostojs/logger'

export function getDefaultLogger() {
    return new ProstoLogger({
        transports: [
            createConsoleTransort({
                format: coloredConsole,
            }),
        ],
    }, 'infact')
}
