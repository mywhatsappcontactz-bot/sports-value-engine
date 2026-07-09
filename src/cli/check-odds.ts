import { getDb } from '../core/database/db';
import { Repository } from '../core/database/repository';

const repo = new Repository(getDb());
const matches = repo.getUpcomingMatches('football');
const target = matches.find(m => m.homeTeam.includes('Malmo'));

if (!target) {
  console.log('Match not found');
} else {
  console.log('Match:', target.homeTeam, 'vs', target.awayTeam);
  const odds = repo.getLatestOdds(target.id);
  const totals = odds.filter(o => o.market === 'totals');
  console.log(JSON.stringify(totals, null, 2));
}