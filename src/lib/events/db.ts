// The slice of a Prisma client this library uses. The outbox/inbox tables
// are part of each service's own schema (copy the models from README.md in
// this folder); this code reaches them with raw, parameterised SQL so it
// doesn't depend on any one service's generated client.
export interface Sql {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
}

export interface Db<Tx extends Sql = Sql> extends Sql {
  $transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
}
