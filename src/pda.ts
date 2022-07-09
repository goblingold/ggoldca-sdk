import * as wh from "@orca-so/whirlpools-sdk";
import { web3 } from "@project-serum/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token-v2";
import { Fetcher } from "./fetcher";

interface VaultKeys {
  vaultAccount: web3.PublicKey;
  vaultLpTokenMintPubkey: web3.PublicKey;
  vaultInputTokenAAccount: web3.PublicKey;
  vaultInputTokenBAccount: web3.PublicKey;
}

interface PositionAccounts {
  whirlpool: web3.PublicKey;
  position: web3.PublicKey;
  positionTokenAccount: web3.PublicKey;
  tickArrayLower: web3.PublicKey;
  tickArrayUpper: web3.PublicKey;
}

interface DepositWithdrawAccounts {
  userSigner: web3.PublicKey;
  vaultAccount: web3.PublicKey;
  vaultLpTokenMintPubkey: web3.PublicKey;
  vaultInputTokenAAccount: web3.PublicKey;
  vaultInputTokenBAccount: web3.PublicKey;
  userLpTokenAccount: web3.PublicKey;
  userTokenAAccount: web3.PublicKey;
  userTokenBAccount: web3.PublicKey;
  whirlpoolProgramId: web3.PublicKey;
  position: PositionAccounts;
  whTokenVaultA: web3.PublicKey;
  whTokenVaultB: web3.PublicKey;
  tokenProgram: web3.PublicKey;
}

export class PDAAccounts {
  fetcher: Fetcher;
  programId: web3.PublicKey;
  cached: Record<string, VaultKeys> = {};

  public constructor(fetcher: Fetcher, programId: web3.PublicKey) {
    this.fetcher = fetcher;
    this.programId = programId;
  }

  async getVaultKeys(poolId: web3.PublicKey): Promise<VaultKeys> {
    const key = poolId.toString();
    if (!this.cached[key]) {
      const [vaultAccount, _bumpVault] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), poolId.toBuffer()],
        this.programId
      );

      const [vaultLpTokenMintPubkey, _bumpLp] =
        web3.PublicKey.findProgramAddressSync(
          [Buffer.from("mint"), vaultAccount.toBuffer()],
          this.programId
        );

      const poolData = await this.fetcher.getWhirlpoolData(poolId);
      const [vaultInputTokenAAccount, vaultInputTokenBAccount] =
        await Promise.all(
          [poolData.tokenMintA, poolData.tokenMintB].map(async (key) =>
            getAssociatedTokenAddress(key, vaultAccount, true)
          )
        );

      this.cached[key] = {
        vaultAccount,
        vaultLpTokenMintPubkey,
        vaultInputTokenAAccount,
        vaultInputTokenBAccount,
      };
    }
    return this.cached[key];
  }

  async getPositionAccounts(
    position: web3.PublicKey
  ): Promise<PositionAccounts> {
    const positionData = await this.fetcher.getWhirlpoolPositionData(position);

    const [poolData, { vaultAccount }] = await Promise.all([
      this.fetcher.getWhirlpoolData(positionData.whirlpool),
      this.getVaultKeys(positionData.whirlpool),
    ]);

    const positionTokenAccount = await getAssociatedTokenAddress(
      positionData.positionMint,
      vaultAccount,
      true
    );

    const startTickLower = wh.TickUtil.getStartTickIndex(
      positionData.tickLowerIndex,
      poolData.tickSpacing
    );

    const startTickUpper = wh.TickUtil.getStartTickIndex(
      positionData.tickUpperIndex,
      poolData.tickSpacing
    );

    const tickArrayLowerPda = wh.PDAUtil.getTickArray(
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      positionData.whirlpool,
      startTickLower
    );

    const tickArrayUpperPda = wh.PDAUtil.getTickArray(
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      positionData.whirlpool,
      startTickUpper
    );

    return {
      whirlpool: positionData.whirlpool,
      position,
      positionTokenAccount,
      tickArrayLower: tickArrayLowerPda.publicKey,
      tickArrayUpper: tickArrayUpperPda.publicKey,
    };
  }

  async getActivePosition(poolId: web3.PublicKey): Promise<web3.PublicKey> {
    const { vaultAccount } = await this.getVaultKeys(poolId);
    const vaultData = await this.fetcher.getVault(vaultAccount, true);
    return vaultData["positions"][0]["pubkey"];
  }

  async getDepositWithdrawAccounts(
    userSigner: web3.PublicKey,
    poolId: web3.PublicKey
  ): Promise<DepositWithdrawAccounts> {
    const [
      {
        vaultAccount,
        vaultLpTokenMintPubkey,
        vaultInputTokenAAccount,
        vaultInputTokenBAccount,
      },
      position,
      poolData,
    ] = await Promise.all([
      this.getVaultKeys(poolId),
      this.getActivePosition(poolId),
      this.fetcher.getWhirlpoolData(poolId),
    ]);

    const positionAccounts = await this.getPositionAccounts(position);
    const [userLpTokenAccount, userTokenAAccount, userTokenBAccount] =
      await Promise.all(
        [vaultLpTokenMintPubkey, poolData.tokenMintA, poolData.tokenMintB].map(
          async (key) => getAssociatedTokenAddress(key, userSigner)
        )
      );

    return {
      userSigner,
      vaultAccount,
      vaultLpTokenMintPubkey,
      vaultInputTokenAAccount,
      vaultInputTokenBAccount,
      userLpTokenAccount,
      userTokenAAccount,
      userTokenBAccount,
      whirlpoolProgramId: wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      position: positionAccounts,
      whTokenVaultA: poolData.tokenVaultA,
      whTokenVaultB: poolData.tokenVaultB,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }
}
