declare module 'better-sqlite3' {
  namespace BetterSqlite3 {
    interface Statement<BindParameters extends unknown[], Result = unknown> {
      run(...params: BindParameters): BetterSqlite3.Database.RunResult;
      get(...params: BindParameters): Result | undefined;
      all(...params: BindParameters): Result[];
    }

    namespace Database {
      interface RunResult {
        changes: number;
        lastInsertRowid: number | bigint;
      }
    }

    interface Database {
      prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(
        source: string,
      ): BindParameters extends unknown[] ? Statement<BindParameters, Result> : Statement<[BindParameters], Result>;
      exec(source: string): this;
      pragma(source: string, options?: unknown): unknown;
      close(): this;
    }

    interface DatabaseConstructor {
      new (filename?: string | Buffer): BetterSqlite3.Database;
      (filename?: string | Buffer): BetterSqlite3.Database;
      prototype: BetterSqlite3.Database;
    }
  }

  const Database: BetterSqlite3.DatabaseConstructor;
  namespace Database {
    type Database = BetterSqlite3.Database;
    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }
  }
  export = Database;
}
