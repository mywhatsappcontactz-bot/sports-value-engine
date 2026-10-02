import 'dotenv/config';
import { syncAllTennisFixturesWithH2H } from './src/data-bridge/tennisFixturesSync';

async function run() {
  const results = await syncAllTennisFixturesWithH2H();
  console.log(JSON.stringify(results, null, 2));
}

run();