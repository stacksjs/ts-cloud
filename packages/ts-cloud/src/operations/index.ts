/**
 * Fleet operations: plan-then-apply changes to live topology.
 *
 * Consolidating servers - moving an app to another box, attaching one as a
 * site, renaming a box, tearing a drained one down - is a routine cleanup that
 * is otherwise an afternoon of SSH. Every operation here is expressed as an
 * {@link OperationPlan}: it says what it would change before touching anything,
 * each step asks reality whether it is already satisfied so a run that died
 * halfway resumes by being run again, irreversible steps are gated on typed
 * confirmation, and nothing reads stdin so the whole sequence drives from CI.
 *
 * These modules existed for several releases without being exported, so they
 * type-checked on import and threw at runtime. This barrel is what makes them
 * reachable.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 * @see https://github.com/stacksjs/ts-cloud/issues/191
 */

export * from './drained-sites'
export * from './inventory'
export * from './plan'
export * from './server-rename'
export * from './site-attach'
export * from './site-move'
