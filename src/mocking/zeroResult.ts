/**
 * The zero answer, anywhere an answer goes: `.returns(zeroResult)`,
 * `defaults`, or a resolver's return. `.returns()` with no value answers it.
 * - a contract function: Solidity zero values for every output (`0n`,
 *   `false`, the zero address, …), or nothing for one without outputs;
 * - a send mock (`write` or `sendTransaction`): a success without logs;
 * - `getBalance`, `getGasPrice`, `estimateMaxPriorityFeePerGas` and
 *   `getBlobBaseFee`: `0n`; `getTransactionCount`: `0`;
 * - `getCode`: `"0x"`; `getStorageAt`: 32 zero bytes; `getLogs`: `[]`;
 * - `getBlock`, `getTransaction`, `getTransactionReceipt` and
 *   `getFeeHistory`: `{}`, a mock with no fields, which answers as each
 *   action's hover says for a mock;
 * - a `mock.method()` mock: `null`.
 *
 * An estimate has none, so it's refused there.
 */
export const zeroResult = Symbol("zeroResult");
