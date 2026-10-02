// Maps internal league names (matching FCSTATS_LEAGUE_MAP's keys) to
// soccerstats.com's URL codes. Used by teamResultsScraper.ts (via
// realFetcher.ts, and now also scrape.ts) as a fallback/primary form-data
// source now that fcStatsScraper.ts is Cloudflare-blocked (confirmed
// 26 Jul 2026, still blocked as of 2026-08-04).
//
// Every code below confirmed directly against soccerstats.com's own
// nav bar or a real latest.asp page — no guesses. 'Brazil Série B' added
// 2026-08-04 — it's in FCSTATS_LEAGUE_MAP but was missing here; code
// confirmed via canonical-URL check (see verify-fcstats-league-map.ts).
// 'Portugal - Liga Portugal' isn't in FCSTATS_LEAGUE_MAP at all — left in
// as a harmless bonus entry from earlier coverage, costs nothing since
// scrape.ts only ever looks up leagues actually present in
// FCSTATS_LEAGUE_MAP.
export const SOCCERSTATS_LEAGUE_MAP: Record<string, string> = {
  'EPL':                          'england',
  'Championship':                 'england2',
  'League 1':                     'england3',
  'League 2':                     'england4',
  'La Liga - Spain':              'spain',
  'La Liga 2 - Spain':            'spain2',
  'Ligue 1 - France':             'france',
  'Bundesliga - Germany':         'germany',
  'Dutch Eredivisie':             'netherlands',
  'Serie A - Italy':              'italy',
  'Premiership - Scotland':       'scotland',
  'Allsvenskan - Sweden':         'sweden',
  'Superettan - Sweden':          'sweden2',
  'Eliteserien - Norway':         'norway',
  'Austrian Football Bundesliga': 'austria',
  'Swiss Superleague':            'switzerland',
  'Denmark Superliga':            'denmark',
  'Veikkausliiga - Finland':      'finland',
  'K League 1':                   'southkorea',
  'Brazil Série A':               'brazil',
  'Brazil Série B':               'brazil2',
  'Portugal - Liga Portugal':     'portugal',
  'League of Ireland':            'ireland',
  'Super League - China':         'china',
  'MLS':                          'usa',
  'Ukraine Premier League':       'ukraine',
  'Russia Premier League':        'russia',
  'Poland Ekstraklasa':           'poland',
};