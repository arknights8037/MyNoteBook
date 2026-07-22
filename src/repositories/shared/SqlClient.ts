export type SqlValue = string | number | boolean | null

export interface SqlExecuteResult {
  rowsAffected: number
  lastInsertId?: number
}

export interface SqlClient {
  execute(sql: string, bindValues?: SqlValue[]): Promise<SqlExecuteResult>
  select<T extends Record<string, unknown>>(sql: string, bindValues?: SqlValue[]): Promise<T[]>
  close?(databaseUrl?: string): Promise<boolean>
}
