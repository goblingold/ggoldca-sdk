import * as wh from "@orca-so/whirlpools-sdk";
import {
  AnchorProvider,
  BN,
  Idl,
  Program,
  utils,
  web3,
} from "@project-serum/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token-v2";
import { Decimal } from "decimal.js";
import { Fetcher } from "./fetcher";
import IDL from "./idl/ggoldca.json";
import { PDAAccounts } from "./pda";

const DAO_TREASURY_PUBKEY = new web3.PublicKey(
  "8XhNoDjjNoLP5Rys1pBJKGdE8acEC1HJsWGkfkMt6JP1"
);

interface InitializeVaultParams {
  userSigner: web3.PublicKey;
  poolId: web3.PublicKey;
}

interface OpenPositionParams {
  lowerPrice: Decimal;
  upperPrice: Decimal;
  userSigner: web3.PublicKey;
  poolId: web3.PublicKey;
  positionMint: web3.PublicKey;
}

interface DepositParams {
  lpAmount: BN;
  maxAmountA: BN;
  maxAmountB: BN;
  userSigner: web3.PublicKey;
  poolId: web3.PublicKey;
  position: web3.PublicKey;
}

interface WithdrawParams {
  lpAmount: BN;
  minAmountA: BN;
  minAmountB: BN;
  userSigner: web3.PublicKey;
  poolId: web3.PublicKey;
  position: PositionAccounts;
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

interface PositionAccounts {
  whirlpool: web3.PublicKey;
  position: web3.PublicKey;
  positionTokenAccount: web3.PublicKey;
  tickArrayLower: web3.PublicKey;
  tickArrayUpper: web3.PublicKey;
}

interface ConstructorParams {
  programId: web3.PublicKey;
  connection: web3.Connection;
}

export class GGoldcaSDK {
  program;
  fetcher: Fetcher;
  connection: web3.Connection;
  pdaAccounts: PDAAccounts;

  public constructor(params: ConstructorParams) {
    const { programId, connection } = params;

    this.connection = connection;
    this.fetcher = new Fetcher(connection);
    this.pdaAccounts = new PDAAccounts(this.fetcher, programId);
    this.program = new Program(
      IDL as Idl,
      programId,
      null as unknown as AnchorProvider
    );
  }

  async initializeVaultTx(
    params: InitializeVaultParams
  ): Promise<web3.Transaction> {
    const { poolId, userSigner } = params;
    const {
      vaultAccount,
      vaultLpTokenMintPubkey,
      vaultInputTokenAAccount,
      vaultInputTokenBAccount,
    } = await this.pdaAccounts.getVaultKeys(poolId);

    const poolData = await this.fetcher.getWhirlpoolData(poolId);

    const daoTreasuryLpTokenAccount = await getAssociatedTokenAddress(
      vaultLpTokenMintPubkey,
      DAO_TREASURY_PUBKEY,
      false
    );

    const tx = await this.program.methods
      .initializeVault()
      .accounts({
        userSigner,
        whirlpool: poolId,
        inputTokenAMintAddress: poolData.tokenMintA,
        inputTokenBMintAddress: poolData.tokenMintB,
        vaultAccount,
        vaultLpTokenMintPubkey,
        vaultInputTokenAAccount,
        vaultInputTokenBAccount,
        daoTreasuryLpTokenAccount,
        daoTreasuryOwner: DAO_TREASURY_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .transaction();

    // Create rewards ATAs
    const rewardMints = poolData.rewardInfos
      .map((info) => info.mint)
      .filter((k) => k.toString() !== web3.PublicKey.default.toString());

    const rewardAccounts = await Promise.all(
      rewardMints.map(async (key) =>
        getAssociatedTokenAddress(key, vaultAccount, true)
      )
    );

    rewardAccounts.forEach((pubkey, indx) => {
      tx.add(
        createAssociatedTokenAccountInstruction(
          userSigner,
          pubkey,
          vaultAccount,
          rewardMints[indx]
        )
      );
    });

    return tx;
  }

  async openPositionTx(params: OpenPositionParams): Promise<web3.Transaction> {
    const { lowerPrice, upperPrice, userSigner, poolId, positionMint } = params;

    const poolData = await this.fetcher.getWhirlpoolData(poolId);

    await this.fetcher.save([poolData.tokenMintA, poolData.tokenMintB]);
    const [mintA, mintB] = await Promise.all(
      [poolData.tokenMintA, poolData.tokenMintB].map((key) =>
        this.fetcher.getMint(key)
      )
    );

    const tokenADecimal = mintA.decimals;
    const tokenBDecimal = mintB.decimals;

    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(poolId);

    const tickLower = wh.TickUtil.getInitializableTickIndex(
      wh.PriceMath.priceToTickIndex(lowerPrice, tokenADecimal, tokenBDecimal),
      poolData.tickSpacing
    );
    const tickUpper = wh.TickUtil.getInitializableTickIndex(
      wh.PriceMath.priceToTickIndex(upperPrice, tokenADecimal, tokenBDecimal),
      poolData.tickSpacing
    );

    const positionPda = wh.PDAUtil.getPosition(
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      positionMint
    );

    const positionTokenAccount = await getAssociatedTokenAddress(
      positionMint,
      vaultAccount,
      true
    );

    const startTickLower = wh.TickUtil.getStartTickIndex(
      tickLower,
      poolData.tickSpacing
    );

    const startTickUpper = wh.TickUtil.getStartTickIndex(
      tickUpper,
      poolData.tickSpacing
    );

    const tickArrayLowerPda = wh.PDAUtil.getTickArray(
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      poolId,
      startTickLower
    );

    const tickArrayUpperPda = wh.PDAUtil.getTickArray(
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      poolId,
      startTickUpper
    );

    const ctx = wh.WhirlpoolContext.withProvider(
      this.program.provider,
      wh.ORCA_WHIRLPOOL_PROGRAM_ID
    );

    // TODO only create if not exists
    const initTickLowerIx = wh.WhirlpoolIx.initTickArrayIx(ctx.program, {
      startTick: startTickLower,
      tickArrayPda: tickArrayLowerPda,
      whirlpool: poolId,
      funder: userSigner,
    });

    const initTickUpperIx = wh.WhirlpoolIx.initTickArrayIx(ctx.program, {
      startTick: startTickUpper,
      tickArrayPda: tickArrayUpperPda,
      whirlpool: poolId,
      funder: userSigner,
    });

    return this.program.methods
      .openPosition(positionPda.bump, tickLower, tickUpper)
      .accounts({
        userSigner,
        vaultAccount,
        whirlpoolProgramId: wh.ORCA_WHIRLPOOL_PROGRAM_ID,
        position: positionPda.publicKey,
        positionMint,
        positionTokenAccount,
        whirlpool: poolId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .preInstructions([initTickLowerIx, initTickUpperIx])
      .transaction();
  }

  async depositIx(params: DepositParams): Promise<web3.TransactionInstruction> {
    const { lpAmount, maxAmountA, maxAmountB, userSigner, poolId, position } =
      params;

    const positionAccounts = await this.getPositionAccounts(position);
    const accounts = await this.depositWithdrawAccounts(
      userSigner,
      poolId,
      positionAccounts
    );

    return this.program.methods
      .deposit(lpAmount, maxAmountA, maxAmountB)
      .accounts(accounts)
      .instruction();
  }

  async withdrawIx(
    params: WithdrawParams
  ): Promise<web3.TransactionInstruction> {
    const { lpAmount, minAmountA, minAmountB, userSigner, poolId, position } =
      params;

    const accounts = await this.depositWithdrawAccounts(
      userSigner,
      poolId,
      position
    );

    return this.program.methods
      .withdraw(lpAmount, minAmountA, minAmountB)
      .accounts(accounts)
      .instruction();
  }

  async getPositionAccounts(
    position: web3.PublicKey
  ): Promise<PositionAccounts> {
    const positionData = await this.fetcher.getWhirlpoolPositionData(position);
    const poolData = await this.fetcher.getWhirlpoolData(
      positionData.whirlpool
    );

    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(
      positionData.whirlpool
    );

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

  async depositWithdrawAccounts(
    userSigner,
    poolId,
    position
  ): Promise<DepositWithdrawAccounts> {
    const poolData = await this.fetcher.getWhirlpoolData(poolId);

    const {
      vaultAccount,
      vaultLpTokenMintPubkey,
      vaultInputTokenAAccount,
      vaultInputTokenBAccount,
    } = await this.pdaAccounts.getVaultKeys(poolId);

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
      position,
      whTokenVaultA: poolData.tokenVaultA,
      whTokenVaultB: poolData.tokenVaultB,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }
}
