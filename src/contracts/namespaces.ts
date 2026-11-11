import type { AbiFunction, Hex } from "viem";

import { encodeGas } from "../mocking/gas.js";
import type { Builder } from "../mocking/handlers.js";
import {
  type MockWriteOutcome,
  encodeWriteOutcome,
  extendWriteBuilder,
  minedReverted,
} from "../transactions/writes.js";
import { encodeResult } from "./answers.js";
import type { MockNamespace } from "./types.js";

/** What a contract's mock answers in each namespace, encoded. */
type Answers = { read: Hex; simulate: Hex; estimateGas: Hex; write: MockWriteOutcome };

/** What a contract's mock answers in `namespace`, encoded. */
export type AnswerIn<namespace extends MockNamespace> = Answers[namespace];

/**
 * How a contract's mocks answer in one namespace. The rest is the
 * contract's: a revert is its ABI's in every namespace, and every resolver
 * gets the same context.
 */
type NamespaceAnswers<answer> = {
  /**
   * Checks a mock's answer to the function `abiItem` and converts it to the
   * request's. At registration it only checks a static answer, which is held
   * as given and encoded again when it answers.
   */
  encode: (abiItem: AbiFunction, value: unknown) => answer;
  /** Adds to a mock's builder: a send's `.emits()` and resolver `emit`. */
  extendBuilder?: (builder: Builder) => void;
  /**
   * What a revert answers instead of being thrown, encoded as a mock's answer
   * is: a send is mined reverted.
   */
  reverted?: MockWriteOutcome;
};

/**
 * An encoder of a function's return data, as `eth_call` answers it, naming
 * `namespace` in messages.
 */
const returnData = (namespace: MockNamespace) => (abiItem: AbiFunction, value: unknown) =>
  encodeResult(abiItem, value, `${namespace}.${abiItem.name}'s answer`);

/** How a contract's mocks answer in each namespace: see `NamespaceAnswers`. */
export const answersIn: { [namespace in MockNamespace]: NamespaceAnswers<AnswerIn<namespace>> } = {
  read: { encode: returnData("read") },
  simulate: { encode: returnData("simulate") },
  estimateGas: {
    encode: (abiItem, value) => encodeGas(value, `estimateGas.${abiItem.name}'s answer`),
  },
  write: {
    encode: (_, value) => encodeWriteOutcome(value, false),
    extendBuilder: extendWriteBuilder,
    reverted: minedReverted,
  },
};
