declare module "better-sqlite3" {
  export interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export interface Database {
    pragma(source: string): unknown;
    exec(source: string): void;
    prepare(source: string): Statement;
    close(): void;
  }

  export default class DatabaseConstructor implements Database {
    constructor(filename: string);
    pragma(source: string): unknown;
    exec(source: string): void;
    prepare(source: string): Statement;
    close(): void;
  }
}
