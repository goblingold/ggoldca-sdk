import {
  MAX_SWAP_TICK_ARRAYS,
  PDAUtil,
  TickUtil,
} from "@orca-so/whirlpools-sdk";
import { web3 } from "@project-serum/anchor";

// copied from https://yugure-sol.notion.site/TickArray-Edge-case-63d071aabec946e0bc5e057936a289a2
export function getTickArrayPublicKeysWithShift(
  tickCurrentIndex: number,
  tickSpacing: number,
  aToB: boolean,
  programId: web3.PublicKey,
  whirlpoolAddress: web3.PublicKey
) {
  let offset = 0;
  const tickArrayAddresses: web3.PublicKey[] = [];
  for (let i = 0; i < MAX_SWAP_TICK_ARRAYS; i++) {
    let startIndex: number;
    try {
      const shift = aToB ? 0 : tickSpacing;
      startIndex = TickUtil.getStartTickIndex(
        tickCurrentIndex + shift,
        tickSpacing,
        offset
      );
    } catch {
      return tickArrayAddresses;
    }

    const pda = PDAUtil.getTickArray(programId, whirlpoolAddress, startIndex);
    tickArrayAddresses.push(pda.publicKey);
    offset = aToB ? offset - 1 : offset + 1;
  }

  return tickArrayAddresses;
}
