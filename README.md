# prostojs/infact

Zero dependency **In**stance **Fact**ory and Instance Registry for Metadata based Dependency Injection scenarios. **Infact** = **In***stance* **fact***ory*. 

It solves the programmatic dependency injection problem in a generic way. You must take care of metadata yourself.

## Install

`npm install @prostojs/infact`

## How to use it

```ts
import { Infact, createProvideRegistry } from '@prostojs/infact'

const infact = new Infact({
    // it is required to provide a `describeClass`
    // function that would read metadata
    // and provide minimum required meta to
    // infact instance
    describeClass: classConstructor => {
        return {
            // only injectable: true classes can be instantiated
            injectable: true,

            // you may want to save some instances in global registry
            // in order to share those among Infact instances
            global: false,

            // provide registry can override some
            // dependencies by string key or by class type itself
            provide: createProvideRegistry([
                ['string key', () => new SomeClass()],
                [SomeClass, () => new SomeClass()],
            ]),

            // list of properties (optional)
            // used for resolveProp
            properties: ['prop1', 'prop2']

            // you must provide constructor params descriptions
            // you may want to take types from design:paramtypes metadata
            constructorParams: [
                {
                    type: SomeClass,
                },
                // considering circular dependency
                // design:paramtypes would be undefined
                // but you still can provide a type via
                // circular function:
                {
                    type: undefined,
                    circular: () => CircularDepClass, 
                },
                // to utilize provided by string key dependencies
                // you may use `inject` property
                {
                    type: SomeClass,
                    inject: 'string key', 
                },
            ],
        }
    },

    // describeProp (optionally) used tp
    // read prop metadata
    describeProp: (classConstructor, key) => {
        return {
            // return property metadata
        }
    }

    // resolveParam is optional function that is used for constructor params.
    // you might want to use this function to inject some constants or whatever
    // additional logic based on some additional resolvers...
    resolveParam: ({ paramMeta, classMeta, index, customData }) => {
        // must return some value | undefined
        // let's say we want to inject every string param with its index value
        return paramMeta.type === String ? (index + '') : undefined
    },,

    // resolveProp is optional function that is used for instance props
    // you might want to use this function to inject some constants or whatever
    // additional logic based on some additional resolvers...
    resolveProp: ({ key, initialValue, propMeta, classMeta, customData }) => {
        // must return some value | undefined
        // let's say we want to inject every string param with its key
        return propMeta.type === String ? key : undefined
    },

    // storeProvideRegByInstance is optional flag
    // if true it stores computed "provideRegistry" for the original instance
    // which allowes to use "getForInstance" method inheriting the
    // "provideRegistry" that was used when the original instance was created
    storeProvideRegByInstance: true
})

// after all required metadata fields are mapped to
// TInfactClassMeta interface everything is ready
// to instantiate your classes instances:
const mainInstance = infact.get(MainClass)

// anotherInstance will be created (retrieved) with "provideRegistry" taken from mainInstance
// (only if options.storeProvideRegByInstance flag is true)
const anotherInstance = infact.getForInstance(mainInstance, ClildClass)
```