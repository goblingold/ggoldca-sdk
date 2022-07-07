import {
  ParsablePosition,
  ParsableWhirlpool,
  PositionData,
  WhirlpoolData,
} from "@orca-so/whirlpools-sdk";
import { utils, web3 } from "@project-serum/anchor";
import { MintLayout, RawMint } from "@solana/spl-token-v2";

export class Fetcher {
  private connection: web3.Connection;
  cached: Map<string, Buffer>;

  public constructor(connection: web3.Connection) {
    this.connection = connection;
    this.cached = new Map<string, Buffer>();
  }

  async getMint(pubkey: web3.PublicKey): Promise<RawMint> {
    const buffer = await this.getOrFetchBuffer(pubkey);
    return MintLayout.decode(buffer);
  }

  async getWhirlpoolData(poolId: web3.PublicKey): Promise<WhirlpoolData> {
    const buffer = await this.getOrFetchBuffer(poolId);
    const pool = ParsableWhirlpool.parse(buffer);
    if (!pool) {
      throw new Error(
        "Cannot decode " + poolId.toString() + " as WhirlpoolData"
      );
    }
    return pool;
  }

  async getWhirlpoolPositionData(pubkey: web3.PublicKey): Promise<PositionData> {
    const buffer = await this.getOrFetchBuffer(pubkey);
    const data = ParsablePosition.parse(buffer);
    if (!data) {
      throw new Error(
        "Cannot decode " + pubkey.toString() + " as WhPositionData"
      );
    }
    return data;
  }

  async save(pubkeys: web3.PublicKey[]) {
    const notCached = pubkeys.filter((p) => !this.cached.has(p.toString()));
    if (notCached.length) await this.fetchAndSave(notCached);
  }

  private async getOrFetchBuffer(pubkey: web3.PublicKey): Promise<Buffer> {
    let key = pubkey.toString();
    let buffer = this.cached.get(key);
    if (!buffer) {
      await this.save([pubkey]);
      buffer = this.cached.get(key)!;
    }
    return buffer;
  }

  private async fetchAndSave(pubkeys: web3.PublicKey[]) {
    const accountInfos = await utils.rpc.getMultipleAccounts(
      this.connection,
      pubkeys
    );

    accountInfos.forEach((info, i) => {
      const key = pubkeys[i].toString();
      const data = info?.account.data;

      if (!data) throw new Error("Cannot fetch " + key);
      this.cached.set(key, data);
    });
  }
}
