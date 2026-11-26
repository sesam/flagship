import { DurableObject } from "cloudflare:workers";
import { FlagshipHubCore, type SqlStorageLike } from "./core";
import type { Env } from "./types";

export class FlagshipHub extends DurableObject<Env> {
  private readonly core: FlagshipHubCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: SqlStorageLike = {
      exec: <T = Record<string, unknown>>(query: string, ...bindings: unknown[]) => ({
        toArray: () => ctx.storage.sql.exec(query, ...bindings).toArray() as unknown as T[],
      }),
    };
    this.core = new FlagshipHubCore(
      sql,
      env.FLAGSHIP_VERSION ?? "0.1.0",
      undefined,
      env.CORS_ORIGIN,
    );
  }

  async fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }
}
