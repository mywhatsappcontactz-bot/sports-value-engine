import { oddsClient } from './src/data-bridge/apiClients/oddsClient';
async function test() {
  oddsClient.clearCache('football');
  const { matches } = await oddsClient.fetchForSport('football');
  console.log('Done — check logs above for API credits line');
}
test();