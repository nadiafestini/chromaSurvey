declare module "*.csv?raw" {
  const content: string;
  export default content;
}

declare module "cloudflare:test" {
  export function applyD1Migrations(db: D1Database, migrations: D1Migration[]): Promise<void>;
}

interface D1Migration {
  name: string;
  queries: string[];
}
