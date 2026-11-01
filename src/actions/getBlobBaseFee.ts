import { numberToHex } from "viem";

import { blobBaseFee } from "../chain/fees.js";
import { encodeQuantity, viewQuantity } from "./decode.js";
import type { Definition } from "./table.js";
import type { EmptyCall } from "./types.js";

/** `eth_blobBaseFee`: unmocked, 1 wei, the protocol's minimum. */
export const getBlobBaseFee = (): Definition<EmptyCall> => ({
  name: "getBlobBaseFee",
  hint: "mock.actions.getBlobBaseFee().returns(…)",
  decode: () => ({}),
  zero: 0n,
  encode: encodeQuantity("A blob base fee"),
  view: viewQuantity,
  fallback: () => numberToHex(blobBaseFee),
});
