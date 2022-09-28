import { Percentage } from "@orca-so/sdk";
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
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token-v2";
import { Decimal } from "decimal.js";
import { Fetcher } from "./fetcher";
import IDL from "./idl/ggoldca.json";
import { PDAAccounts, VaultId } from "./pda";
import { Pools } from "./pools";
import { isSwapAtoB } from "./reinvest";
import { swapRewardsAccounts } from "./swapRewards";

const DAO_TREASURY_PUBKEY = new web3.PublicKey(
  "8XhNoDjjNoLP5Rys1pBJKGdE8acEC1HJsWGkfkMt6JP1"
);

const PROGRAM_ID = new web3.PublicKey(
  "NAZAREQQuCnkV8CpkGZaoB6ccmvikM8uRr4GKPWwmPT"
);

interface InitializeVaultParams {
  userSigner: web3.PublicKey;
  vaultId: VaultId;
  fee: BN;
  minSlots: BN;
}

interface OpenPositionParams {
  lowerPrice: Decimal;
  upperPrice: Decimal;
  userSigner: web3.PublicKey;
  vaultId: VaultId;
  positionMint: web3.PublicKey;
}

interface ClosePositionParams {
  userSigner: web3.PublicKey;
  vaultId: VaultId;
  position: web3.PublicKey;
}

interface RebalanceParams {
  userSigner: web3.PublicKey;
  vaultId: VaultId;
  newPosition: web3.PublicKey;
}

interface DepositParams {
  lpAmount: BN;
  maxAmountA: BN;
  maxAmountB: BN;
  userSigner: web3.PublicKey;
  vaultId: VaultId;
}

interface WithdrawParams {
  lpAmount: BN;
  minAmountA: BN;
  minAmountB: BN;
  userSigner: web3.PublicKey;
  vaultId: VaultId;
}

interface CollectFeesParams {
  position: web3.PublicKey;
  vaultId: VaultId;
}

interface CollectRewardsParams {
  position: web3.PublicKey;
  vaultId: VaultId;
}

interface SellRewardsParams {
  vaultId: VaultId;
}

interface ReinvestParams {
  vaultId: VaultId;
  position?: web3.PublicKey;
}

interface ConstructorParams {
  connection: web3.Connection;
  provider: Provider;
  programId?: web3.PublicKey;
}

interface SetMinSlotsForReinvestParams {
  userSigner: web3.PublicKey;
  vaultId: VaultId;
  minSlots: BN;
}

interface SetVaultUiStatusParams {
  userSigner: web3.PublicKey;
  vaultId: VaultId;
  isActive: boolean;
}

interface SetVaultPauseStatusParams {
  userSigner: web3.PublicKey;
  vaultId: VaultId;
  isPaused: boolean;
}

interface SetVaultFeeParams {
  userSigner: web3.PublicKey;
  vaultId: VaultId;
  fee: BN;
}

interface SetMarketRewardsParams {
  userSigner: web3.PublicKey;
  vaultId: VaultId;
  rewardsMint: web3.PublicKey;
  marketRewards: object;
  destinationTokenAccount: web3.PublicKey;
}

interface TransferRewards {
  vaultId: VaultId;
  rewardsIndex: number;
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
    const { vaultId, userSigner } = params;
    const {
      vaultAccount,
      vaultLpTokenMintPubkey,
      vaultInputTokenAAccount,
      vaultInputTokenBAccount,
    } = await this.pdaAccounts.getVaultKeys(vaultId);

    const poolData = await this.fetcher.getWhirlpoolData(vaultId.whirlpool);

    const ix = await this.program.methods
      .initializeVault(vaultId.id, params.fee, params.minSlots)
      .accounts({
        userSigner,
        whirlpool: vaultId.whirlpool,
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
    const { lowerPrice, upperPrice, userSigner, vaultId, positionMint } =
      params;

    const poolData = await this.fetcher.getWhirlpoolData(vaultId.whirlpool);

    await this.fetcher.save([poolData.tokenMintA, poolData.tokenMintB]);
    const [mintA, mintB] = await Promise.all(
      [poolData.tokenMintA, poolData.tokenMintB].map((key) =>
        this.fetcher.getMint(key)
      )
    );

    const tokenADecimal = mintA.decimals;
    const tokenBDecimal = mintB.decimals;

    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(vaultId);

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
        whirlpool: vaultId.whirlpool,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();

    // Check the existence of the tick arrays
    const ixs: web3.TransactionInstruction[] = [ix];

    const [tickLowerIx, tickUpperIx] = await Promise.all([
      this.createTickArrayIx(userSigner, vaultId.whirlpool, tickLower),
      this.createTickArrayIx(userSigner, vaultId.whirlpool, tickUpper),
    ]);

    if (tickLowerIx != null) ixs.push(tickLowerIx);
    if (tickUpperIx != null) ixs.push(tickUpperIx);

    return ixs;
  }

  async closePositionIx(
    params: ClosePositionParams
  ): Promise<web3.TransactionInstruction> {
    const { userSigner, vaultId, position } = params;

    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(vaultId);
    const positionData = await this.fetcher.getWhirlpoolPositionData(position);

    const positionTokenAccount = await getAssociatedTokenAddress(
      positionData.positionMint,
      vaultAccount,
      true
    );

    return this.program.methods
      .closePosition()
      .accounts({
        userSigner,
        vaultAccount,
        whirlpoolProgramId: wh.ORCA_WHIRLPOOL_PROGRAM_ID,
        position: position,
        positionMint: positionData.positionMint,
        positionTokenAccount,
      })
      .instruction();
  }

  async rebalanceIx(
    params: RebalanceParams
  ): Promise<web3.TransactionInstruction> {
    const { userSigner, vaultId, newPosition } = params;

    const [
      poolData,
      currentPosition,
      { vaultAccount, vaultInputTokenAAccount, vaultInputTokenBAccount },
    ] = await Promise.all([
      this.fetcher.getWhirlpoolData(vaultId.whirlpool),
      this.pdaAccounts.getActivePosition(vaultId),
      this.pdaAccounts.getVaultKeys(vaultId),
    ]);

    const [currentPositionAccounts, newPositionAccounts] = await Promise.all([
      this.pdaAccounts.getPositionAccounts(currentPosition, vaultId),
      this.pdaAccounts.getPositionAccounts(newPosition, vaultId),
    ]);

    return this.program.methods
      .rebalance()
      .accounts({
        userSigner,
        vaultAccount,
        vaultInputTokenAAccount,
        vaultInputTokenBAccount,
        whirlpoolProgramId: wh.ORCA_WHIRLPOOL_PROGRAM_ID,
        tokenVaultA: poolData.tokenVaultA,
        tokenVaultB: poolData.tokenVaultB,
        currentPosition: currentPositionAccounts,
        newPosition: newPositionAccounts,
      })
      .transaction();
  }

  async depositIx(params: DepositParams): Promise<web3.TransactionInstruction> {
    const { lpAmount, maxAmountA, maxAmountB, userSigner, vaultId } = params;

    const accounts = await this.pdaAccounts.getDepositWithdrawAccounts(
      userSigner,
      vaultId
    );

    return this.program.methods
      .deposit(lpAmount, maxAmountA, maxAmountB)
      .accounts(accounts)
      .instruction();
  }

  async withdrawIx(
    params: WithdrawParams
  ): Promise<web3.TransactionInstruction> {
    const { lpAmount, minAmountA, minAmountB, userSigner, vaultId } = params;

    const accounts = await this.pdaAccounts.getDepositWithdrawAccounts(
      userSigner,
      vaultId
    );

    return this.program.methods
      .withdraw(lpAmount, minAmountA, minAmountB)
      .accounts(accounts)
      .instruction();
  }

  async collectFeesIx(
    params: CollectFeesParams
  ): Promise<web3.TransactionInstruction> {
    const { vaultId, position } = params;

    const positionData = await this.fetcher.getWhirlpoolPositionData(position);
    const poolData = await this.fetcher.getWhirlpoolData(
      positionData.whirlpool
    );

    const [
      positionAccounts,
      { vaultAccount, vaultInputTokenAAccount, vaultInputTokenBAccount },
    ] = await Promise.all([
      this.pdaAccounts.getPositionAccounts(position, vaultId),
      this.pdaAccounts.getVaultKeys(vaultId),
    ]);

    const [treasuryTokenAAccount, treasuryTokenBAccount] = await Promise.all([
      getAssociatedTokenAddress(poolData.tokenMintA, DAO_TREASURY_PUBKEY),
      getAssociatedTokenAddress(poolData.tokenMintB, DAO_TREASURY_PUBKEY),
    ]);

    return this.program.methods
      .collectFees()
      .accounts({
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
    const { vaultId, position } = params;

    const positionData = await this.fetcher.getWhirlpoolPositionData(position);
    const poolData = await this.fetcher.getWhirlpoolData(
      positionData.whirlpool
    );

    const [positionAccounts, { vaultAccount }] = await Promise.all([
      this.pdaAccounts.getPositionAccounts(position, vaultId),
      this.pdaAccounts.getVaultKeys(vaultId),
    ]);

    const rewardInfos = poolData.rewardInfos.filter(
      (info) => !info.emissionsPerSecondX64.eq(new BN(0))
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

  async transferRewards(
    params: TransferRewards
  ): Promise<web3.TransactionInstruction> {
    const { vaultId, rewardsIndex } = params;

    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(vaultId);
    const vaultData = await this.fetcher.getVault(vaultAccount, true);
    const market = vaultData["marketRewards"][rewardsIndex];

    const vaultRewardsTokenAccount = await getAssociatedTokenAddress(
      market.rewardsMint,
      vaultAccount,
      true
    );

    // TODO ensure market.id is a Transfer
    return this.program.methods
      .transferRewards()
      .accounts({
        vaultAccount,
        vaultRewardsTokenAccount,
        destinationTokenAccount: market.destinationTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async swapRewardsIxs(
    params: SellRewardsParams
  ): Promise<web3.TransactionInstruction[]> {
    const { vaultId } = params;

    const [poolData, { vaultAccount }] = await Promise.all([
      this.fetcher.getWhirlpoolData(vaultId.whirlpool),
      this.pdaAccounts.getVaultKeys(vaultId),
    ]);

    const rewardMints = poolData.rewardInfos
      .map((info) => info.mint)
      .filter((mint) => mint.toString() !== web3.PublicKey.default.toString());

    const swapAccounts = await swapRewardsAccounts(
      vaultId.whirlpool,
      rewardMints,
      this.fetcher
    );

    // no swap available
    if (swapAccounts.length == 0) {
      return [];
    } else {
      const vaultRewardsTokenAccounts = await Promise.all(
        rewardMints.map(async (mint) =>
          getAssociatedTokenAddress(mint, vaultAccount, true)
        )
      );

      const vaultDestinationTokenAccounts = await Promise.all(
        swapAccounts.map(async (swap) =>
          getAssociatedTokenAddress(
            swap.destinationTokenMint,
            vaultAccount,
            true
          )
        )
      );

      return await Promise.all(
        swapAccounts.map(async (swap, indx) =>
          this.program.methods
            .swapRewards()
            .accounts({
              vaultAccount,
              vaultRewardsTokenAccount: vaultRewardsTokenAccounts[indx],
              vaultDestinationTokenAccount: vaultDestinationTokenAccounts[indx],
              tokenProgram: TOKEN_PROGRAM_ID,
              swapProgram: swap.programId,
            })
            .remainingAccounts(swap.metas)
            .instruction()
        )
      );
    }
  }

  async reinvestIx(
    params: ReinvestParams
  ): Promise<web3.TransactionInstruction> {
    const { vaultId } = params;

    const position =
      params.position ?? (await this.pdaAccounts.getActivePosition(vaultId));

    const [
      {
        vaultAccount,
        vaultLpTokenMintPubkey,
        vaultInputTokenAAccount,
        vaultInputTokenBAccount,
      },
      positionAccounts,
    ] = await Promise.all([
      this.pdaAccounts.getVaultKeys(vaultId),
      this.pdaAccounts.getPositionAccounts(position, vaultId),
    ]);

    const oracleKeypair = wh.PDAUtil.getOracle(
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultId.whirlpool
    );

    await this.fetcher.save(
      [
        vaultId.whirlpool,
        position,
        vaultInputTokenAAccount,
        vaultInputTokenBAccount,
      ],
      true
    );

    const [poolData, positionData, vaultTokenAData, vaultTokenBData] =
      await Promise.all([
        this.fetcher.getWhirlpoolData(vaultId.whirlpool),
        this.fetcher.getWhirlpoolPositionData(position),
        this.fetcher.getAccount(vaultInputTokenAAccount),
        this.fetcher.getAccount(vaultInputTokenBAccount),
      ]);

    const isAtoB = isSwapAtoB(
      poolData.sqrtPrice,
      positionData.liquidity,
      positionData.tickLowerIndex,
      positionData.tickUpperIndex,
      vaultTokenAData.amount,
      vaultTokenBData.amount
    );

    const tickArrayAddresses = wh.SwapUtils.getTickArrayPublicKeys(
      poolData.tickCurrentIndex,
      poolData.tickSpacing,
      isAtoB,
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      positionAccounts.whirlpool
    );

    // Ugly Fix
    // TODO Check with Orca why this is happening
    let tickArray0 = tickArrayAddresses[0];
    let tickArray1 = tickArrayAddresses[1];
    let tickArray2 = tickArrayAddresses[2];
    if (vaultId.whirlpool.toString() == Pools.USDC_USDT) {
      tickArray0 = tickArrayAddresses[1];
      tickArray1 = tickArrayAddresses[0];
      tickArray2 = tickArrayAddresses[2];
    }
    return this.program.methods
      .reinvest()
      .accounts({
        vaultAccount,
        whirlpoolProgramId: wh.ORCA_WHIRLPOOL_PROGRAM_ID,
        vaultLpTokenMintPubkey,
        vaultInputTokenAAccount,
        vaultInputTokenBAccount,
        tokenVaultA: poolData.tokenVaultA,
        tokenVaultB: poolData.tokenVaultB,
        position: positionAccounts,
        tickArray0,
        tickArray1,
        tickArray2,
        oracle: oracleKeypair.publicKey,
      })
      .instruction();
  }

  async createTickArrayIx(
    userSigner: web3.PublicKey,
    whirlpool: web3.PublicKey,
    tickIndex: number
  ): Promise<null | web3.TransactionInstruction> {
    const poolData = await this.fetcher.getWhirlpoolData(whirlpool);

    const startTick = wh.TickUtil.getStartTickIndex(
      tickIndex,
      poolData.tickSpacing
    );

    const tickArrayPda = wh.PDAUtil.getTickArray(
      wh.ORCA_WHIRLPOOL_PROGRAM_ID,
      whirlpool,
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
        whirlpool,
        funder: userSigner,
      }).instructions[0];
    } else {
      return null;
    }
  }

  increaseLiquidityQuoteByInputToken(
    inputTokenAmount: Decimal,
    tickLower: number,
    tickUpper: number,
    inputMint: web3.PublicKey,
    slippageTolerance: Percentage,
    whirlpool: wh.Whirlpool
  ): wh.IncreaseLiquidityQuote {
    return wh.increaseLiquidityQuoteByInputToken(
      inputMint,
      inputTokenAmount,
      tickLower,
      tickUpper,
      slippageTolerance,
      whirlpool
    );
  }

  async setMinSlotsForReinvestIx(
    params: SetMinSlotsForReinvestParams
  ): Promise<web3.TransactionInstruction> {
    const { userSigner, vaultId, minSlots } = params;
    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(vaultId);

    return this.program.methods
      .setMinSlotsForReinvest(minSlots)
      .accounts({
        userSigner,
        vaultAccount,
      })
      .instruction();
  }

  async setVaultUiStatusIx(
    params: SetVaultUiStatusParams
  ): Promise<web3.TransactionInstruction> {
    const { userSigner, vaultId, isActive } = params;
    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(vaultId);

    return this.program.methods
      .setVaultUiStatus(isActive)
      .accounts({
        userSigner,
        vaultAccount,
      })
      .instruction();
  }

  async setVaultPauseStatus(
    params: SetVaultPauseStatusParams
  ): Promise<web3.TransactionInstruction> {
    const { userSigner, vaultId, isPaused } = params;
    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(vaultId);

    return this.program.methods
      .setVaultPauseStatus(isPaused)
      .accounts({
        userSigner,
        vaultAccount,
      })
      .instruction();
  }

  async setVaultFee(
    params: SetVaultFeeParams
  ): Promise<web3.TransactionInstruction> {
    const { userSigner, vaultId, fee } = params;

    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(vaultId);

    return this.program.methods
      .setVaultFee(fee)
      .accounts({
        userSigner,
        vaultAccount,
      })
      .instruction();
  }

  async setMarketRewards(
    params: SetMarketRewardsParams
  ): Promise<web3.TransactionInstruction> {
    const { userSigner, vaultId, marketRewards } = params;
    const { vaultAccount } = await this.pdaAccounts.getVaultKeys(vaultId);

    return this.program.methods
      .setMarketRewards(marketRewards)
      .accounts({
        userSigner,
        vaultAccount,
        whirlpool: vaultId.whirlpool,
        rewardsMint: params.rewardsMint,
        destinationTokenAccount: params.destinationTokenAccount,
      })
      .instruction();
  }
}
