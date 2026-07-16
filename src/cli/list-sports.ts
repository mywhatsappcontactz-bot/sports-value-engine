import 'dotenv/config';

async function main() {
  const apiKey = process.env.THE_ODDS_API_KEY;
  const res = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${apiKey}`);
  const data = await res.json();

  const basketball = (data as any[]).filter(s => s.key.startsWith('basketball_'));
  const hockey = (data as any[]).filter(s => s.key.startsWith('icehockey_'));
  const soccer = (data as any[]).filter(s => s.key.startsWith('soccer_'));

  console.log('=== BASKETBALL ===', basketball.map(s => ({ key: s.key, title: s.title })));
  console.log('=== HOCKEY ===', hockey.map(s => ({ key: s.key, title: s.title })));
  console.log('=== SOCCER (' + soccer.length + ') ===', soccer.map(s => ({ key: s.key, title: s.title })));
}

main();