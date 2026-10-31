/**
 * Answers with Solidity zero values for every output (`0n`, `false`, the zero
 * address, …), or with nothing for a function without outputs. Use it anywhere
 * a return value goes: `.returns(zeroResult)`, `defaults`, or from a resolver.
 */
export const zeroResult = Symbol("zeroResult");
