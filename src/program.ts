import {
  ORCA_TOKEN_SWAP_ID,
  OrcaPoolConfig,
  getOrca,
  Percentage,
} from "@orca-so/sdk";
import { OrcaPoolParams } from "@orca-so/sdk/dist/model/orca/pool/pool-types";
import * as wh from "@orca-so/whirlpools-sdk";
import {
  AnchorProvider,
  BN,
  Idl,
  Program,
  Provider,
  utils,
  web3,
} from "@project-serum/anchor";
import { u64 } from "@solana/spl-token";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token-v2";
import { Decimal } from "decimal.js";
import { Fetcher } from "./fetcher";
import IDL from "./idl/ggoldca.json";
import { PDAAccounts } from "./pda";
import { Pools } from "./pools";

const DAO_TREASURY_PUBKEY = new web3.PublicKey(
  "8XhNoDjjNoLP5Rys1pBJKGdE8acEC1HJsWGkfkMt6JP1"
);

const PROGRAM_ID = new web3.PublicKey(
  "ECzqPRCK7S7jXeNWoc3QrYH6yWQkcQGpGR2RWqRQ9e9P"
);

function getOrcaRewardSwapPools(poolId: web3.PublicKey): OrcaPoolParams[] {
  const orca = getOrca(null as unknown as web3.Connection);

  switch (poolId.toString()) {
    case Pools.USDH_USDC:
      return [
        orca.getPool(OrcaPoolConfig.HBB_USDC)["poolParams"],
        orca.getPool(OrcaPoolConfig.ORCA_USDC)["poolParams"],
      ];
    default:
      throw new Error("unset swap pool for " + poolId);
  }
}

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
}

interface WithdrawParams {
  lpAmount: BN;
  minAmountA: BN;
  minAmountB: BN;
  userSigner: web3.PublicKey;
  poolId: web3.PublicKey;
}

interface CollectFeesParams {
  userSigner: web3.PublicKey;
  position: web3.PublicKey;
}

interface CollectRewardsParams {
  userSigner: web3.PublicKey;
  position: web3.PublicKey;
}

interface SellRewardsParams {
  userSigner: web3.PublicKey;
  poolId: web3.PublicKey;
}

interface ReinvestParams {
  userSigner: web3.PublicKey;
  poolId: web3.PublicKey;
}

interface ConstructorParams {
  connection: web3.Connection;
  provider: Provider;
  programId?: web3.PublicKey;
}

export class GGoldcaSDK {
  program;
  fetcher: Fetcher;
  connection: web3.Connection;
  pdaAccounts: PDAAccounts;

  public constructor(params: ConstructorParams) {
    const { connection, provider } = params;
    const programId = params.programId ? params.programId : PROGRAM_ID;

    this.connection = connection;
    this.fetcher = new Fetcher(connection);
    this.pdaAccounts = new PDAAccounts(this.fetcher, programId);
    this.program = new Program(
      IDL as Idl,
      programId,
      provider ? provider : (null as unknown as AnchorProvider)
    );
  }

  async initializeVaultIxs(
    params: InitializeVaultParams
  ): Promise<web3.TransactionInstruction[]> {
    const { poolId, userSigner } = params;
    const {
      vaultAccount,
      vaultLpTokenMintPubkey,
      vaultInputTokenAAccount,
      vaultInputTokenBAccount,
    } = await this.pdaAccounts.getVaultKeys(poolId);

    const poolData = await this.fetcher.getWhirlpoolData(poolId);

    const ix = await this.program.methods
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
        systemProgram: web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    // Create vault_rewards ATAs
    const rewardMints = poolData.rewardInfos
      .map((info) => info.mint)
      .filter((k) => k.toString() !== web3.PublicKey.default.toString());

    const vaultRewardsAtas = await Promise.all(
      rewardMints.map(async (key) =>
        getAssociatedTokenAddress(key, vaultAccount, true)
      )
    );

    const ixVaultAtas = vaultRewardsAtas.map((pubkey, indx) =>
      createAssociatedTokenAccountInstruction(
        userSigner,
        pubkey,
        vaultAccount,
        rewardMints[indx]
      )
    );

    // Create non-existing treasury ATAs
    const mints = [poolData.tokenMintA, poolData.tokenMintB, ...rewardMints];

    const treasuryAtas = await Promise.all(
      mints.map(async (key) =>
        getAssociatedTokenAddress(key, DAO_TREASURY_PUBKEY)
      )
    );

    const accInfos = await utils.rpc.getMultipleAccounts(
      this.connection,
      treasuryAtas
    );

    const ixTreasuryAtas = treasuryAtas
      .map((pubkey, indx) =>
        createAssociatedTokenAccountInstruction(
          userSigner,
          pubkey,
          DAO_TREASURY_PUBKEY,
          mints[indx]
        )
      )
      .filter((ix, indx) => accInfos[indx] == null);

    return [ix, ...ixVaultAtas, ...ixTreasuryAtas];
  }

  async openPositionIxs(
    params: OpenPositionParams
  ): Promise<web3.TransactionInstruction[]> {
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

    const ix = await this.program.methods
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
      .instruction();

    // Check the existence of the tick arrays
    const ixs: web3.TransactionInstruction[] = [ix];

    const [tickLowerIx, tickUpperIx] = await Promise.all([
      this.createTickArrayIx(userSigner, poolId, tickLower),
      this.createTickArrayIx(userSigner, poolId, tickUpper),
    ]);

    if (tickLowerIx != null) ixs.push(tickLowerIx);
    if (tickUpperIx != null) ixs.push(tickUpperIx);

    return ixs;
  }

  async depositIx(params: DepositParams): Promise<web3.TransactionInstruction> {
    const { lpAmount, maxAmountA, maxAmountB, userSigner, poolId } = params;

    const accounts = await this.pdaAccounts.getDepositWithdrawAccounts(
      userSigner,
      poolId
    );

    return this.program.methods
      .deposit(lpAmount, maxAmountA, maxAmountB)
      .accounts(accounts)
      .instruction();
  }

  async withdrawIx(
    params: WithdrawParams
  ): Promise<web3.TransactionInstruction> {
    const { lpAmount, minAmountA, minAmountB, userSigner, poolId } = params;

    const accounts = await this.pdaAccounts.getDepositWithdrawAccounts(
      userSigner,
      poolId
    );

    return this.program.methods
      .withdraw(lpAmount, minAmountA, minAmountB)
      .accounts(accounts)
      .instruction();
  }

  async collectFeesIx(
    params: CollectFeesParams
  ): Promise<web3.TransactionInstruction> {
    const { userSigner, position } = params;

    const positionData = await this.fetcher.getWhirlpoolPositionData(position);
    const poolData = await this.fetcher.getWhirlpoolData(
      positionData.whirlpool
    );

    const [
      positionAccounts,
      { vaultAccount, vaultInputTokenAAccount, vaultInputTokenBAccount },
    ] = await Promise.all([
      this.pdaAccounts.getPositionAccounts(position),
      this.pdaAccounts.getVaultKeys(positionData.whirlpool),
    ]);

    const [treasuryTokenAAccount, treasuryTokenBAccount] = await Promise.all([
      getAssociatedTokenAddress(poolData.tokenMintA, DAO_TREASURY_PUBKEY),
      getAssociatedTokenAddress(poolData.tokenMintB, DAO_TREASURY_PUBKEY),
    ]);

    return this.program.methods
      .collectFees()
      .accounts({
        userSigner,
        vaultAccount,
        whirlpoolProgramId: wh.ORCA_WHIRLPOOL_PROGRAM_ID,
        vaultInputTokenAAccount,
        vaultInputTokenBAccount,
        treasuryTokenAAccount,
        treasuryTokenBAccount,
        tokenVaultA: poolData.tokenVaultA,
        tokenVaultB: poolData.tokenVaultB,
        position: positionAccounts,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async collectRewardsIxs(
    params: CollectRewardsParams
  ): Promise<web3.TransactionInstruction[]> {
    const { userSigner, position } = params;

    const positionData = await this.fetcher.getWhirlpoolPositionData(position);
    const poolData = await this.fetcher.getWhirlpoolData(
      positionData.whirlpool
    );

    const [positionAccounts, { vaultAccount }] = await Promise.all([
      this.pdaAccounts.getPositionAccounts(position),
      this.pdaAccounts.getVaultKeys(positionData.whirlpool),
    ]);

    const rewardInfos = poolData.rewardInfos.filter(
      (info) => info.mint.toString() !== web3.PublicKey.default.toString()
    );

    const vaultRewardsTokenAccounts = await Promise.all(
      rewardInfos.map(async (info) =>
        getAssociatedTokenAddress(info.mint, vaultAccount, true)
      )
    );

    const treasuryRewardsTokenAccounts = await Promise.all(
      rewardInfos.map(async (info) =>
        getAssociatedTokenAddress(info.mint, DAO_TREASURY_PUBKEY)
      )
    );

    return await Promise.all(
      rewardInfos.map(async (info, indx) =>
        this.program.methods
          .collectRewards(indx)
          .accounts({
            userSigner,
            vaultAccount,
            rewardVault: info.vault,
            vaultRewardsTokenAccount: vaultRewardsTokenAccounts[indx],
            treasuryRewardsTokenAccount: treasuryRewardsTokenAccounts[indx],
            whirlpoolProgramId: wh.ORCA_WHIRLPOOL_PROGRAM_ID,
            position: positionAccounts,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction()
      )
    );
  }

  async sellRewardsIxs(
    params: SellRewardsParams
  ): Promise<web3.TransactionInstruction[]> {
    const { userSigner, poolId } = params;

    const [poolData, { vaultAccount }] = await Promise.all([
      this.fetcher.getWhirlpoolData(poolId),
      this.pdaAccounts.getVaultKeys(poolId),
    ]);

    const rewardMints = poolData.rewardInfos
      .map((info) => info.mint)
      .filter((mint) => mint.toString() !== web3.PublicKey.default.toString());

    const vaultRewardsTokenAccounts = await Promise.all(
      rewardMints.map(async (mint) =>
        getAssociatedTokenAddress(mint, vaultAccount, true)
      )
    );

    const swapPools = getOrcaRewardSwapPools(poolId);

    const vaultDestinationTokenAccounts = await Promise.all(
      swapPools
        .map((pool) => pool.tokenIds)
        .flat()
        .filter((token) => !JSON.stringify(rewardMints).includes(token))
        .map(async (token) => {
          const mint = new web3.PublicKey(token);
          return getAssociatedTokenAddress(mint, vaultAccount, true);
        })
    );

    return await Promise.all(
      swapPools.map(async (pool, indx) =>
        this.program.methods
          .sellRewards()
          .accounts({
            userSigner,
            vaultAccount,
            vaultRewardsTokenAccount: vaultRewardsTokenAccounts[indx],
            vaultInputTokenAccount: vaultDestinationTokenAccounts[indx],
            orcaProgram: ORCA_TOKEN_SWAP_ID,
            pool: pool.address,
            poolAuthority: pool.authority,
            poolSourceTokenAccount: pool.tokens[pool.tokenIds[0]].addr,
            poolDestinationTokenAccount: pool.tokens[pool.tokenIds[1]].addr,
            poolMintAccount: pool.poolTokenMint,
            poolFeeAccount: pool.feeAccount,
            programId: TOKEN_PROGRAM_ID,
          })
          .instruction()
      )
    );
  }

  async reinvestIx(
    params: ReinvestParams
  ): Promise<web3.TransactionInstruction> {
    const { userSigner, poolId } = params;

    const [
      poolData,
      position,
      { vaultAccount, vaultInputTokenAAccount, vaultInputTokenBAccount },
    ] = await Promise.all([
      this.fetcher.getWhirlpoolData(poolId),
      this.pdaAccounts.getActivePosition(poolId),
      this.pdaAccounts.getVaultKeys(poolId),
    ]);

    const positionAccounts = await this.pdaAccounts.getPositionAccounts(
      position
    );

    const oracleKeypair = wh.PDAUtil.getOracle(
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      poolId
    );

    // TODO compute swap direction
    const isAtoB = false;
    const tickArrayAddresses = wh.PoolUtil.getTickArrayPublicKeysForSwap(
      poolData.tickCurrentIndex,
      poolData.tickSpacing,
      isAtoB,
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      positionAccounts.whirlpool
    );

    return this.program.methods
      .reinvest()
      .accounts({
        userSigner,
        vaultAccount,
        whirlpoolProgramId: wh.ORCA_WHIRLPOOL_PROGRAM_ID,
        vaultInputTokenAAccount,
        vaultInputTokenBAccount,
        tokenVaultA: poolData.tokenVaultA,
        tokenVaultB: poolData.tokenVaultB,
        position: positionAccounts,
        tickArray0: tickArrayAddresses[0],
        tickArray1: tickArrayAddresses[1],
        tickArray2: tickArrayAddresses[2],
        oracle: oracleKeypair.publicKey,
      })
      .instruction();
  }

  async createTickArrayIx(
    userSigner: web3.PublicKey,
    poolId: web3.PublicKey,
    tickIndex: number
  ): Promise<null | web3.TransactionInstruction> {
    const poolData = await this.fetcher.getWhirlpoolData(poolId);

    const startTick = wh.TickUtil.getStartTickIndex(
      tickIndex,
      poolData.tickSpacing
    );

    const tickArrayPda = wh.PDAUtil.getTickArray(
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      poolId,
      startTick
    );

    const [tickInfo] = await utils.rpc.getMultipleAccounts(this.connection, [
      tickArrayPda.publicKey,
    ]);

    if (tickInfo == null) {
      const ctx = wh.WhirlpoolContext.withProvider(
        this.program.provider,
        wh.ORCA_WHIRLPOOL_PROGRAM_ID
      );
      return wh.WhirlpoolIx.initTickArrayIx(ctx.program, {
        startTick,
        tickArrayPda,
        whirlpool: poolId,
        funder: userSigner,
      }).instructions[0];
    } else {
      return null;
    }
  }

  async increaseLiquidityQuoteByInputToken(
    inputTokenAmount: u64,
    poolId: web3.PublicKey,
    inputMint: web3.PublicKey,
    slippageTolerance: Percentage
  ) {
    const position = await this.pdaAccounts.getActivePosition(poolId);
    const [poolData, positionData] = await Promise.all([
      this.fetcher.getWhirlpoolData(poolId, true),
      this.fetcher.getWhirlpoolPositionData(position, true),
    ]);
    return wh.increaseLiquidityQuoteByInputTokenWithParams({
      inputTokenMint: inputMint,
      inputTokenAmount,
      tickLowerIndex: positionData.tickLowerIndex,
      tickUpperIndex: positionData.tickUpperIndex,
      slippageTolerance,
      ...poolData,
    });
  }
}
