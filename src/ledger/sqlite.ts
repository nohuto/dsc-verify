export type Store = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type Binding = string | number | null;

export function selectOne<T extends Record<string, SqlStorageValue>>(
  store: Store,
  query: string,
  ...bindings: Binding[]
): T | undefined {
  return store.sql.exec<T>(query, ...bindings).toArray()[0];
}

export function selectAll<T extends Record<string, SqlStorageValue>>(
  store: Store,
  query: string,
  ...bindings: Binding[]
): T[] {
  return store.sql.exec<T>(query, ...bindings).toArray();
}

export function execute(store: Store, query: string, ...bindings: Binding[]): void {
  store.sql.exec(query, ...bindings).toArray();
}

export function updatedRows(store: Store, query: string, ...bindings: Binding[]): number {
  return store.sql.exec(query, ...bindings).toArray().length;
}
