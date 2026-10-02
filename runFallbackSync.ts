// runFallbackSync.ts
import { syncAllFallbackLeagues } from './src/data-bridge/soccerStatsFallbackFixturesSync';

async function run() {
  console.log('Running fallback sync...');
  const results = await syncAllFallbackLeagues();
  console.log('Sync results:', results);
}

run();