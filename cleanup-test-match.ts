// cleanup-test-match.ts
import { getDb } from './src/core/database/db';

async function main() {
  const db = getDb();
  const result = db.prepare(`DELETE FROM matches WHERE externalId = 'test-corners-agg-001'`).run();
  console.log('Deleted rows:', result.changes);
}

main().catch(console.error);