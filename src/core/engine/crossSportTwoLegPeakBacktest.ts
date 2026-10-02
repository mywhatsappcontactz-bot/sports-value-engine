
// src/core/engine/crossSportTwoLegPeakBacktest.ts
// One 2-leg parlay per calendar day + independent single-bet accounting.
// Uses the project's real probabilityModel.ts.
// Hockey *_all.csv: Home/Away prices are treated as regulation prices;
// After OT / After Pen. therefore settle as losses for Home/Away picks.

import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const STAKE = 10_000;
const CONFIDENCE_FLOOR = 0.70;
const MIN_ODDS = 1.45;
const MAX_ODDS = 2.40;
const MIN_HISTORY = 5;
const ROOT = process.cwd();
const REQUIRE_DIFFERENT_LEAGUES = process.env.REQUIRE_DIFFERENT_LEAGUES === '1';
const REQUIRE_DIFFERENT_SPORTS = process.env.REQUIRE_DIFFERENT_SPORTS === '1';

type Sport = 'basketball' | 'hockey';
interface Config { label:string; sport:Sport; file:string }
interface Game { date:Date; dateKey:string; tournament:string; stage:string; status:string; home:string; away:string; hs:number; as:number; ho:number; ao:number; sport:Sport; league:string }
interface Hist { date:Date; opp:string; res:'W'|'L'; home:boolean; pf:number; pa:number }
interface Leg { date:string; dateObj:Date; league:string; sport:Sport; team:string; opponent:string; side:'home'|'away'; won:boolean; odds:number; modelProbability:number; confidence:number; edge:number; status:string; tournament:string; stage:string }
interface Parlay { date:string; legs:[Leg,Leg]; odds:number; won:boolean; profit:number }

const configs: Config[] = [
  {label:'ACB',sport:'basketball',file:process.env.ACB_ODDS_CSV ?? path.join(ROOT,'acb_all_seasons.csv')},
  {label:'BBL',sport:'basketball',file:process.env.BBL_ODDS_CSV ?? path.join(ROOT,'bbl_all.csv')},
  {label:'BLS',sport:'basketball',file:process.env.BLS_ODDS_CSV ?? path.join(ROOT,'bls_all.csv')},
  {label:'FRA',sport:'basketball',file:process.env.FRA_ODDS_CSV ?? path.join(ROOT,'fra_all.csv')},
  {label:'GRE',sport:'basketball',file:process.env.GRE_ODDS_CSV ?? path.join(ROOT,'gre_all.csv')},
  {label:'ITA',sport:'basketball',file:process.env.ITA_ODDS_CSV ?? path.join(ROOT,'ita_all.csv')},
  {label:'TUR',sport:'basketball',file:process.env.TUR_ODDS_CSV ?? path.join(ROOT,'tur_all.csv')},
  {label:'AHL',sport:'hockey',file:process.env.AHL_ODDS_CSV ?? path.join(ROOT,'ahl_all.csv')},
  {label:'DEL',sport:'hockey',file:process.env.DEL_ODDS_CSV ?? path.join(ROOT,'del_all.csv')},
  {label:'DEL2',sport:'hockey',file:process.env.DEL2_ODDS_CSV ?? path.join(ROOT,'del2_all.csv')},
  {label:'DENMARK',sport:'hockey',file:process.env.DENMARK_ODDS_CSV ?? path.join(ROOT,'denmark_all.csv')},
  {label:'EIHL',sport:'hockey',file:process.env.EIHL_ODDS_CSV ?? path.join(ROOT,'eihl_all.csv')},
  {label:'HOCKEYALLSVENSKAN',sport:'hockey',file:process.env.HOCKEYALLSVENSKAN_ODDS_CSV ?? path.join(ROOT,'hockeyallsvenskan_all.csv')},
  {label:'ICEHL',sport:'hockey',file:process.env.ICEHL_ODDS_CSV ?? path.join(ROOT,'icehl_all.csv')},
  {label:'KHL',sport:'hockey',file:process.env.KHL_ODDS_CSV ?? path.join(ROOT,'khl_all.csv')},
  {label:'LIIGA',sport:'hockey',file:process.env.LIIGA_ODDS_CSV ?? path.join(ROOT,'liiga_all.csv')},
  {label:'MESTIS',sport:'hockey',file:process.env.MESTIS_ODDS_CSV ?? path.join(ROOT,'mestis_all.csv')},
  {label:'NHL',sport:'hockey',file:process.env.NHL_ODDS_CSV ?? path.join(ROOT,'nhl_all.csv')},
  {label:'SHL',sport:'hockey',file:process.env.SHL_ODDS_CSV ?? path.join(ROOT,'shl_all.csv')},
];

function csvLine(s:string):string[]{ const out:string[]=[]; let cur=''; let q=false; for(let i=0;i<s.length;i++){const c=s[i]; if(c==='"'){if(q&&s[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(c===','&&!q){out.push(cur.trim());cur='';}else cur+=c;} out.push(cur.trim()); return out; }
function csv(text:string){return text.split(/\r?\n/).filter(x=>x.trim()).map(csvLine);}
function hdr(s:string){return s.trim().toLowerCase().replace(/^"|"$/g,'');}
function idx(h:string[],...names:string[]){for(const n of names){const i=h.indexOf(n.toLowerCase());if(i>=0)return i;}return -1;}
function parseDate(s:string){const x=s.trim().replace(/^"|"$/g,''); if(/^\d{4}-\d{2}-\d{2}$/.test(x))return new Date(x+'T00:00:00'); const m=x.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/); if(m){const mo:Record<string,string>={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};if(mo[m[2]])return new Date(`${m[3]}-${mo[m[2]]}-${m[1].padStart(2,'0')}T00:00:00`);}return new Date(x);}
function dk(d:Date){return d.toISOString().slice(0,10)}
function avg(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN}
function pct(x:number){return `${(x*100).toFixed(2)}%`}
function money(x:number){return `₦${x.toLocaleString('en-NG',{maximumFractionDigits:0})}`}

function loadGames(c:Config):Game[]{
  if(!fs.existsSync(c.file))throw new Error(`file not found: ${c.file}`);
  const rows=csv(fs.readFileSync(c.file,'utf8')); if(!rows.length)throw new Error('empty CSV');
  const h=rows[0].map(hdr);
  const I={date:idx(h,'date'),tournament:idx(h,'tournament'),stage:idx(h,'stage'),status:idx(h,'status'),home:idx(h,'home_team','home'),hs:idx(h,'home_score','score_home'),away:idx(h,'away_team','away'),as:idx(h,'away_score','score_away'),ho:idx(h,'home_odds','moneyline_home'),ao:idx(h,'away_odds','moneyline_away')};
  const miss=Object.entries(I).filter(([,v])=>v<0).map(([k])=>k); if(miss.length)throw new Error(`${c.label}: missing required CSV column(s): ${miss.join(', ')}`);
  const g:Game[]=[];
  for(let i=1;i<rows.length;i++){const r=rows[i], status=(r[I.status]??'').trim(); if(!/^(Finished|After OT|After Pen\.?)$/i.test(status))continue; const d=parseDate(r[I.date]??''); const hs=Number(r[I.hs]),as=Number(r[I.as]),ho=Number(r[I.ho]),ao=Number(r[I.ao]); if(isNaN(d.getTime())||!Number.isFinite(hs)||!Number.isFinite(as)||hs===as||!Number.isFinite(ho)||!Number.isFinite(ao)||ho<=1||ao<=1)continue; g.push({date:d,dateKey:dk(d),tournament:r[I.tournament]??'',stage:r[I.stage]??'',status,home:r[I.home]??'',away:r[I.away]??'',hs,as,ho,ao,sport:c.sport,league:c.label});}
  g.sort((a,b)=>a.date.getTime()-b.date.getTime()); return g;
}
function h2h(games:Game[],g:Game):H2HRecord[]{return games.filter(x=>x.date<g.date&&((x.home===g.home&&x.away===g.away)||(x.home===g.away&&x.away===g.home))).map(x=>{const flip=x.home!==g.home;const hs=flip?x.as:x.hs,as=flip?x.hs:x.as;return {date:x.date.toISOString(),homeTeam:g.home,awayTeam:g.away,homeScore:hs,awayScore:as,winner:(hs>as?'home':'away') as 'home'|'away'};});}
function form(a:Hist[]):FormRecord[]{return a.slice(-10).map(x=>({date:x.date.toISOString(),opponent:x.opp,result:x.res,goalsFor:x.pf,goalsAgainst:x.pa,venue:x.home?'home':'away'}));}
function settled(g:Game,side:'home'|'away'){if(g.sport==='hockey'&&/^(After OT|After Pen\.?)$/i.test(g.status))return false;return side==='home'?g.hs>g.as:g.as>g.hs;}

function evalLeague(games:Game[],c:Config):Leg[]{
 const hist=new Map<string,Hist[]>(),legs:Leg[]=[]; const push=(t:string,x:Hist[])=>{if(!hist.has(t))hist.set(t,[]);hist.get(t)!.push(...x)};
 for(const g of games){const hh=hist.get(g.home)??[],ah=hist.get(g.away)??[];
  if(hh.length>=MIN_HISTORY&&ah.length>=MIN_HISTORY){const id=`${c.label}-${g.home}-${g.away}-${g.date.toISOString()}`;const h=h2h(games,g);const stats:Stats={id:'s-'+id,matchId:id,sport:c.sport,h2h:h,homeForm:form(hh),awayForm:form(ah),referee:{},situational:{},additionalContext:{league:c.label,stage:g.stage,status:g.status},confidenceFactors:{dataCompleteness:1,h2hSampleSize:h.length,formSampleSize:10}};const input:ModelInput={match:{id,sport:c.sport,homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:c.label},stats,odds:[]};const ps=getProbabilities(input);const hp=ps.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
   if(hp!==undefined&&Number.isFinite(hp)){const home=hp>=.5,prob=home?hp:1-hp,side: 'home'|'away'=home?'home':'away',odds=home?g.ho:g.ao;if(prob>=CONFIDENCE_FLOOR&&odds>=MIN_ODDS&&odds<=MAX_ODDS){legs.push({date:g.dateKey,dateObj:g.date,league:c.label,sport:c.sport,team:home?g.home:g.away,opponent:home?g.away:g.home,side,won:settled(g,side),odds,modelProbability:prob,confidence:prob,edge:prob-1/odds,status:g.status,tournament:g.tournament,stage:g.stage});}}
  }
  push(g.home,[{date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as}]); push(g.away,[{date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs}]);
 } return legs;
}
function singleProfit(l:Leg){return l.won?STAKE*(l.odds-1):-STAKE}
function equity<T>(a:T[],pf:(x:T)=>number){let c=0,peak=0,pi=0,dd=0;const h:{profit:number,cum:number}[]=[];for(let i=0;i<a.length;i++){const p=pf(a[i]);c+=p;if(c>peak){peak=c;pi=i+1}dd=Math.max(dd,peak-c);h.push({profit:p,cum:c});}return {c,peak,pi,dd,h}}
function choosePair(a:Leg[]):Parlay|null{if(a.length<2)return null;const s=[...a].sort((x,y)=>y.confidence-x.confidence||y.edge-x.edge||y.odds-x.odds);for(let i=0;i<s.length;i++)for(let j=i+1;j<s.length;j++){if(REQUIRE_DIFFERENT_LEAGUES&&s[i].league===s[j].league)continue;if(REQUIRE_DIFFERENT_SPORTS&&s[i].sport===s[j].sport)continue;const odds=s[i].odds*s[j].odds,won=s[i].won&&s[j].won;return {date:s[i].date,legs:[s[i],s[j]],odds,won,profit:won?STAKE*(odds-1):-STAKE};}return null;}

async function main(){
 console.log('=== CROSS-SPORT 2-LEG PARLAY PEAK BACKTEST ===');console.log(`Stake/single: ${money(STAKE)}`);console.log(`Stake/day parlay: ${money(STAKE)}`);console.log(`Confidence floor: ${CONFIDENCE_FLOOR}`);console.log(`Odds range: ${MIN_ODDS}-${MAX_ODDS}`);console.log(`Minimum team history: ${MIN_HISTORY}`);console.log('Pair selection: confidence');console.log(`Different leagues required: ${REQUIRE_DIFFERENT_LEAGUES}`);console.log(`Different sports required: ${REQUIRE_DIFFERENT_SPORTS}`);console.log('Hockey After OT / After Pen.: LOSS for regulation Home/Away bet');
 let total=0;const all:Leg[]=[];const leagueSummary:any[]=[];
 for(const c of configs){try{const games=loadGames(c);total+=games.length;console.log(`${c.sport.toUpperCase()} ${c.label}: ${games.length.toLocaleString()} games loaded`);const legs=evalLeague(games,c);console.log(`  -> ${c.label} qualifying legs: ${legs.length.toLocaleString()}`);leagueSummary.push({league:c.label,sport:c.sport,games:games.length,legs:legs.length});all.push(...legs);}catch(e:any){console.log(`FAILED ${c.label}: ${e?.message??e}`);leagueSummary.push({league:c.label,sport:c.sport,error:e?.message??String(e)});}}
 all.sort((a,b)=>a.dateObj.getTime()-b.dateObj.getTime()||b.confidence-a.confidence);if(!all.length){console.log('No qualifying legs.');return;}
 console.log(`\nTotal games: ${total.toLocaleString()}`);console.log(`Date range: ${all[0].date} -> ${all[all.length-1].date}`);console.log(`Qualifying single legs: ${all.length.toLocaleString()}`);console.log(`Average leg odds: ${avg(all.map(x=>x.odds)).toFixed(3)}`);console.log(`Average model probability: ${pct(avg(all.map(x=>x.modelProbability)))}`);
 const se=equity(all,singleProfit),sw=all.filter(x=>x.won).length;console.log('\n=== SINGLE-BET RESULT ===');console.log(`Qualifying singles: ${all.length}`);console.log(`Wins: ${sw} (${pct(sw/all.length)})`);console.log(`Losses: ${all.length-sw}`);console.log(`Total staked: ${money(all.length*STAKE)}`);console.log(`Final profit/loss: ${money(se.c)}`);console.log(`FINAL ROI: ${pct(se.c/(all.length*STAKE))}`);console.log(`Peak cumulative profit: ${money(se.peak)}`);if(se.pi)console.log(`Peak occurred: ${all[se.pi-1].date} at single #${se.pi}`);console.log(`Maximum drawdown: ${money(se.dd)}`);
 const by=new Map<string,Leg[]>();for(const l of all){if(!by.has(l.date))by.set(l.date,[]);by.get(l.date)!.push(l)}const parlays:Parlay[]=[];for(const d of [...by.keys()].sort()){const p=choosePair(by.get(d)!);if(p)parlays.push(p)}
 const pe=equity(parlays,x=>x.profit),pw=parlays.filter(x=>x.won).length;console.log('\n=== 2-LEG PARLAY RESULT ===');console.log(`2-leg parlays: ${parlays.length}`);console.log(`Wins: ${pw} (${parlays.length?pct(pw/parlays.length):'0.00%'})`);console.log(`Losses: ${parlays.length-pw}`);console.log(`Average combined odds: ${avg(parlays.map(x=>x.odds)).toFixed(3)}`);console.log(`Maximum combined odds: ${Math.max(0,...parlays.map(x=>x.odds)).toFixed(3)}`);console.log(`Total staked: ${money(parlays.length*STAKE)}`);console.log(`Final profit/loss: ${money(pe.c)}`);console.log(`FINAL ROI: ${pct(pe.c/Math.max(1,parlays.length*STAKE))}`);console.log(`Peak cumulative profit: ${money(pe.peak)}`);if(pe.pi){const p=parlays[pe.pi-1];console.log(`Peak occurred: ${p.date} at parlay #${pe.pi}`);console.log('\n=== PEAK PARLAY ===');for(const l of p.legs)console.log(`  ${l.sport.toUpperCase()} ${l.league}: ${l.team} ${l.side==='home'?'Home':'Away'} @ ${l.odds.toFixed(3)} | model ${pct(l.modelProbability)} | edge ${(l.edge*100).toFixed(1)}pp | ${l.won?'WIN':'LOSS'}`);console.log(`  Combined: ${p.odds.toFixed(3)} | ${p.won?'WIN':'LOSS'} | ${money(p.profit)}`);}console.log(`Maximum drawdown: ${money(pe.dd)}`);
 console.log('\n=== LAST 10 DAILY PARLAYS ===');for(let i=Math.max(0,parlays.length-10);i<parlays.length;i++){const p=parlays[i];console.log(`#${i+1} ${p.date} | ${p.legs.map(l=>`${l.league}:${l.team}@${l.odds.toFixed(2)}${l.won?'✓':'✗'}`).join(' + ')} | ${p.won?'WIN':'LOSS'} | ${money(p.profit)} | cum ${money(pe.h[i].cum)}`)}
 const out={config:{STAKE,CONFIDENCE_FLOOR,MIN_ODDS,MAX_ODDS,MIN_HISTORY,REQUIRE_DIFFERENT_LEAGUES,REQUIRE_DIFFERENT_SPORTS,hockeySettlement:'After OT / After Pen. = loss for regulation Home/Away price',parlayRule:'Exactly one 2-leg parlay per calendar day'},leagues:leagueSummary,singles:all.map((l,i)=>({...l,profit:singleProfit(l),betNumber:i+1,cumulativeProfit:se.h[i].cum})),parlays:parlays.map((p,i)=>({...p,parlayNumber:i+1,cumulativeProfit:pe.h[i].cum}))};const outPath=path.join(ROOT,'cross-sport-two-leg-peak-results.json');fs.writeFileSync(outPath,JSON.stringify(out,null,2));console.log(`\nFull result history written to: ${outPath}`);
}
main().catch(e=>{console.error(e?.stack||e);process.exit(1)});
