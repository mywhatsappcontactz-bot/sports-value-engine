import 'dotenv/config';
import { syncAllTennisFixtures } from './src/data-bridge/tennisFixturesSync';

async function run() {
  const results = await syncAllTennisFixtures();
  console.log(JSON.stringify(results, null, 2));
}

run();