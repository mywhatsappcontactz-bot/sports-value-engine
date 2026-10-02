/**
 * teamFollowingSeasonBacktest.ts
 *
 * Singles-only test of the hypothesis:
 * "Identify strong teams using ONLY results already played in the
 * current season, then bet that team on every subsequent game."
 *
 * No eventual champion information is used.
 * Multiple teams are followed simultaneously.
 * Qualification is checked before today's result is added.
 * The first bet occurs AFTER qualification.
 *
 * Run:
 *   npx ts-node .\src\core\engine\teamFollowingSeasonBacktest.ts
 *
 * Optional:
 *   MIN_ODDS=1.35
 *   STAKE_SINGLE=10000
 *   ENTRY_GAMES=5,10,15,20
 *   WIN_RATE_THRESHOLDS=0.55,0.60,0.65,0.70
 *   PRINT_TEAMS=1
 */

import * as fs from "fs";
import * as path from "path";

type Sport = "basketball" | "hockey";

type Game = {
  date: string;
  tournament: string;
  stage: string;
  status: string;
  home: string;
  homeScore: number;
  away: string;
  awayScore: number;
  homeOdds: number;
  awayOdds: number;
  sport: Sport;
  league: string;
};

type TeamState = {
  games: number;
  wins: number;
  qualified: boolean;
  qualifiedAfter: number;
  qualificationDate: string;
};

type Bet = {
  date: string;
  season: string;
  league: string;
  sport: Sport;
  team: string;
  opponent: string;
  side: "home" | "away";
  odds: number;
  gamesBefore: number;
  winsBefore: number;
  formBefore: number;
  qualifiedAfter: number;
  qualificationDate: string;
  win: boolean;
  profit: number;
};

type TeamSummary = {
  season: string;
  league: string;
  sport: Sport;
  team: string;
  qualifiedAfter: number;
  qualificationDate: string;
  bets: number;
  wins: number;
  losses: number;
  winRate: number;
  profit: number;
  roi: number;
};

const ROOT = process.cwd();
const STAKE_SINGLE = Number(process.env.STAKE_SINGLE || 10000);
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.35);

const ENTRY_GAMES = (process.env.ENTRY_GAMES || "5,10,15,20")
  .split(",").map(Number)
  .filter(x => Number.isInteger(x) && x >= 1);

const WIN_RATE_THRESHOLDS = (process.env.WIN_RATE_THRESHOLDS || "0.55,0.60,0.65,0.70")
  .split(",").map(Number)
  .filter(x => Number.isFinite(x) && x > 0 && x <= 1);

const FILES: Array<{file: string; league: string; sport: Sport}> = [
  {file:"acb_all_seasons.csv", league:"ACB", sport:"basketball"},
  {file:"bbl_all.csv", league:"BBL", sport:"basketball"},
  {file:"bls_all.csv", league:"BLS", sport:"basketball"},
  {file:"fra_all.csv", league:"FRA", sport:"basketball"},
  {file:"gre_all.csv", league:"GRE", sport:"basketball"},
  {file:"ita_all.csv", league:"ITA", sport:"basketball"},
  {file:"tur_all.csv", league:"TUR", sport:"basketball"},
  {file:"ahl_all.csv", league:"AHL", sport:"hockey"},
  {file:"del_all.csv", league:"DEL", sport:"hockey"},
  {file:"del2_all.csv", league:"DEL2", sport:"hockey"},
  {file:"denmark_all.csv", league:"DENMARK", sport:"hockey"},
  {file:"eihl_all.csv", league:"EIHL", sport:"hockey"},
  {file:"hockeyallsvenskan_all.csv", league:"HOCKEYALLSVENSKAN", sport:"hockey"},
  {file:"icehl_all.csv", league:"ICEHL", sport:"hockey"},
  {file:"khl_all.csv", league:"KHL", sport:"hockey"},
  {file:"liiga_all.csv", league:"LIIGA", sport:"hockey"},
  {file:"mestis_all.csv", league:"MESTIS", sport:"hockey"},
  {file:"nhl_all.csv", league:"NHL", sport:"hockey"},
  {file:"shl_all.csv", league:"SHL", sport:"hockey"},
];

function parseCsvLine(line:string):string[] {
  const out:string[]=[]; let cur=""; let quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted && line[i+1]==='"'){cur+='"';i++;}
      else quoted=!quoted;
    } else if(ch==="," && !quoted){out.push(cur.trim());cur="";}
    else cur+=ch;
  }
  out.push(cur.trim());
  return out.map(x=>x.replace(/^"(.*)"$/,"$1").trim());
}

function norm(x:string):string {
  return x.trim().replace(/^"|"$/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
}

function columns(header:string[]):Record<string,number>{
  const m:Record<string,number>={};
  header.forEach((h,i)=>m[norm(h)]=i);
  return m;
}

function col(m:Record<string,number>, aliases:string[], file:string):number{
  for(const a of aliases){const i=m[norm(a)]; if(i!==undefined)return i;}
  throw new Error(`${file}: missing required column ${aliases.join(" / ")}`);
}

function readGames(filename:string, league:string, sport:Sport):Game[]{
  const full=path.join(ROOT,filename);
  if(!fs.existsSync(full)) throw new Error(`file not found: .\\${filename}`);
  const lines=fs.readFileSync(full,"utf8").split(/\r?\n/).filter(x=>x.trim());
  if(lines.length<2)return [];
  const m=columns(parseCsvLine(lines[0]));
  const date=col(m,["Date","GameDate"],filename);
  const tournament=col(m,["Tournament","League","Competition"],filename);
  const stage=col(m,["Stage"],filename);
  const status=col(m,["Status"],filename);
  const home=col(m,["Home_Team","HomeTeam","Home"],filename);
  const hs=col(m,["Home_Score","HomeScore","HomePoints"],filename);
  const away=col(m,["Away_Team","AwayTeam","Away"],filename);
  const as=col(m,["Away_Score","AwayScore","AwayPoints"],filename);
  const ho=col(m,["Home_Odds","HomeOdds","HomePrice"],filename);
  const ao=col(m,["Away_Odds","AwayOdds","AwayPrice"],filename);

  const games:Game[]=[];
  for(let i=1;i<lines.length;i++){
    const p=parseCsvLine(lines[i]);
    const homeScore=Number(p[hs]), awayScore=Number(p[as]);
    const homeOdds=Number(p[ho]), awayOdds=Number(p[ao]);
    if(!p[date]||!p[tournament]||!p[home]||!p[away]||
       !Number.isFinite(homeScore)||!Number.isFinite(awayScore)||
       !Number.isFinite(homeOdds)||!Number.isFinite(awayOdds))continue;
    games.push({
      date:p[date], tournament:p[tournament], stage:p[stage]||"",
      status:p[status]||"Finished", home:p[home], homeScore,
      away:p[away], awayScore, homeOdds, awayOdds, sport, league
    });
  }
  return games;
}

function season(tournament:string):string {
  return tournament.match(/(\d{4}\/\d{4})/)?.[1] || tournament || "UNKNOWN";
}

function winResult(g:Game, home:boolean):boolean {
  if(g.sport==="hockey" && /After OT|After Pen\.?/i.test(g.status)) return false;
  if(g.homeScore===g.awayScore)return false;
  return home ? g.homeScore>g.awayScore : g.awayScore>g.homeScore;
}

function key(g:Game, team:string, s:string):string {
  return `${g.sport}|${g.league}|${s}|${team}`;
}

function profit(odds:number, win:boolean):number {
  return win ? STAKE_SINGLE*(odds-1) : -STAKE_SINGLE;
}

function roi(p:number,bets:number):number {
  return bets ? p/(bets*STAKE_SINGLE)*100 : 0;
}

function money(n:number):string {
  return (n<0?"-":"")+`₦${Math.round(Math.abs(n)).toLocaleString("en-NG")}`;
}

function pct(w:number,n:number):number { return n?w/n*100:0; }

function run(allGames:Game[], entry:number, threshold:number){
  const states=new Map<string,TeamState>();
  const bets:Bet[]=[];

  for(const g of allGames){
    const s=season(g.tournament);
    const hk=key(g,g.home,s), ak=key(g,g.away,s);

    const h=states.get(hk)||{games:0,wins:0,qualified:false,qualifiedAfter:0,qualificationDate:""};
    const a=states.get(ak)||{games:0,wins:0,qualified:false,qualifiedAfter:0,qualificationDate:""};

    // QUALIFY USING ONLY RESULTS BEFORE THIS GAME.
    if(!h.qualified && h.games>=entry && h.wins/h.games>=threshold){
      h.qualified=true; h.qualifiedAfter=h.games; h.qualificationDate=g.date;
    }
    if(!a.qualified && a.games>=entry && a.wins/a.games>=threshold){
      a.qualified=true; a.qualifiedAfter=a.games; a.qualificationDate=g.date;
    }

    // FIRST BET MUST BE A LATER GAME, NOT THE GAME THAT triggered qualification.
    if(h.qualified && h.qualificationDate!==g.date && g.homeOdds>=MIN_ODDS){
      const w=winResult(g,true);
      bets.push({
        date:g.date,season:s,league:g.league,sport:g.sport,team:g.home,
        opponent:g.away,side:"home",odds:g.homeOdds,gamesBefore:h.games,
        winsBefore:h.wins,formBefore:h.wins/h.games,qualifiedAfter:h.qualifiedAfter,
        qualificationDate:h.qualificationDate,win:w,profit:profit(g.homeOdds,w)
      });
    }

    if(a.qualified && a.qualificationDate!==g.date && g.awayOdds>=MIN_ODDS){
      const w=winResult(g,false);
      bets.push({
        date:g.date,season:s,league:g.league,sport:g.sport,team:g.away,
        opponent:g.home,side:"away",odds:g.awayOdds,gamesBefore:a.games,
        winsBefore:a.wins,formBefore:a.wins/a.games,qualifiedAfter:a.qualifiedAfter,
        qualificationDate:a.qualificationDate,win:w,profit:profit(g.awayOdds,w)
      });
    }

    // ADD RESULT ONLY AFTER THE GAME HAS BEEN EVALUATED.
    h.games++; a.games++;
    if(winResult(g,true))h.wins++;
    if(winResult(g,false))a.wins++;
    states.set(hk,h); states.set(ak,a);
  }

  const grouped=new Map<string,Bet[]>();
  for(const b of bets){
    const k=key({sport:b.sport,league:b.league} as Game,b.team,b.season);
    if(!grouped.has(k))grouped.set(k,[]);
    grouped.get(k)!.push(b);
  }

  const teams:TeamSummary[]=[];
  for(const [k,bs] of grouped){
    const [sport,league,s,team]=k.split("|");
    const wins=bs.filter(x=>x.win).length;
    const p=bs.reduce((x,b)=>x+b.profit,0);
    teams.push({
      season:s,league,sport:sport as Sport,team,
      qualifiedAfter:bs[0].qualifiedAfter,
      qualificationDate:bs[0].qualificationDate,
      bets:bs.length,wins,losses:bs.length-wins,
      winRate:pct(wins,bs.length),profit:p,roi:roi(p,bs.length)
    });
  }
  return {bets,teams};
}

function printResult(r:{bets:Bet[],teams:TeamSummary[]}){
  const wins=r.bets.filter(x=>x.win).length;
  const p=r.bets.reduce((s,b)=>s+b.profit,0);
  console.log(`Bets: ${r.bets.length}`);
  console.log(`Total staked: ${money(r.bets.length*STAKE_SINGLE)}`);
  console.log(`Wins: ${wins} (${pct(wins,r.bets.length).toFixed(2)}%)`);
  console.log(`Losses: ${r.bets.length-wins}`);
  console.log(`Final profit/loss: ${money(p)}`);
  console.log(`FINAL ROI: ${roi(p,r.bets.length).toFixed(2)}%`);
}

function printSeasons(bets:Bet[]){
  const m=new Map<string,Bet[]>();
  for(const b of bets){if(!m.has(b.season))m.set(b.season,[]);m.get(b.season)!.push(b);}
  console.log("\n=== SEASON-BY-SEASON ===");
  console.log("Season       Bets Win%   P/L          ROI");
  console.log("------------------------------------------------");
  for(const [s,bs] of [...m].sort()){
    const w=bs.filter(x=>x.win).length,p=bs.reduce((a,b)=>a+b.profit,0);
    console.log(`${s.padEnd(12)} ${String(bs.length).padStart(4)} ${pct(w,bs.length).toFixed(1).padStart(5)}% ${money(p).padStart(12)} ${roi(p,bs.length).toFixed(2).padStart(8)}%`);
  }
}

function printLeagues(bets:Bet[]){
  const m=new Map<string,Bet[]>();
  for(const b of bets){const k=`${b.sport}|${b.league}`;if(!m.has(k))m.set(k,[]);m.get(k)!.push(b);}
  console.log("\n=== LEAGUE RESULTS ===");
  console.log("League                Sport        Bets Win%   P/L          ROI");
  console.log("----------------------------------------------------------------");
  for(const [k,bs] of [...m].sort()){
    const [,l]=k.split("|"),w=bs.filter(x=>x.win).length,p=bs.reduce((a,b)=>a+b.profit,0);
    console.log(`${l.padEnd(20)} ${bs[0].sport.padEnd(12)} ${String(bs.length).padStart(4)} ${pct(w,bs.length).toFixed(1).padStart(5)}% ${money(p).padStart(12)} ${roi(p,bs.length).toFixed(2).padStart(8)}%`);
  }
}

function printTeams(teams:TeamSummary[]){
  console.log("\n=== TEAM-BY-TEAM RESULTS ===");
  console.log("Season       League                Team                           QualAfter Bets Win%   P/L          ROI");
  console.log("----------------------------------------------------------------------------------------------------------");
  for(const t of [...teams].sort((a,b)=>b.profit-a.profit)){
    console.log(`${t.season.padEnd(12)} ${t.league.padEnd(20)} ${t.team.slice(0,30).padEnd(30)} ${String(t.qualifiedAfter).padStart(9)} ${String(t.bets).padStart(4)} ${t.winRate.toFixed(1).padStart(5)}% ${money(t.profit).padStart(12)} ${t.roi.toFixed(2).padStart(8)}%`);
  }
}

function main(){
  console.log("=== TEAM-FOLLOWING SEASON BACKTEST ===");
  console.log("Singles only. No parlays. No eventual-champion information.");
  console.log(`Stake: ${money(STAKE_SINGLE)} | Minimum odds: ${MIN_ODDS.toFixed(2)}`);
  console.log(`Entry points: ${ENTRY_GAMES.join(", ")} games`);
  console.log(`Thresholds: ${WIN_RATE_THRESHOLDS.map(x=>(x*100).toFixed(0)+"%").join(", ")}`);

  const games:Game[]=[];
  for(const f of FILES){
    try{
      const g=readGames(f.file,f.league,f.sport); games.push(...g);
      console.log(`${f.sport.toUpperCase()} ${f.league}: ${g.length.toLocaleString()} games loaded`);
    }catch(e){console.error(`FAILED ${f.league}: ${e instanceof Error?e.message:String(e)}`);}
  }
  games.sort((a,b)=>a.date.localeCompare(b.date));
  console.log(`Total games: ${games.length.toLocaleString()}`);
  if(games.length)console.log(`Date range: ${games[0].date} -> ${games[games.length-1].date}`);

  const comparison:any[]=[];

  for(const entry of ENTRY_GAMES){
    for(const threshold of WIN_RATE_THRESHOLDS){
      console.log(`\n============================================================`);
      console.log(`ENTRY AFTER ${entry} GAMES | WIN RATE >= ${(threshold*100).toFixed(0)}%`);
      console.log(`============================================================`);
      const r=run(games,entry,threshold);
      printResult(r);
      printSeasons(r.bets);
      printLeagues(r.bets);
      if(process.env.PRINT_TEAMS==="1")printTeams(r.teams);

      const wins=r.bets.filter(x=>x.win).length;
      const p=r.bets.reduce((s,b)=>s+b.profit,0);
      comparison.push({
        entryGames:entry,threshold,
        qualifiedTeams:r.teams.length,
        bets:r.bets.length,wins,losses:r.bets.length-wins,
        winRate:pct(wins,r.bets.length),profit:p,
        roi:roi(p,r.bets.length),
        profitableTeams:r.teams.filter(x=>x.profit>0).length,
        losingTeams:r.teams.filter(x=>x.profit<0).length
      });
    }
  }

  console.log("\n============================================================");
  console.log("=== STRATEGY COMPARISON ===");
  console.log("============================================================");
  console.log("Entry Threshold Teams Bets Win%     P/L          ROI");
  console.log("------------------------------------------------------------");
  for(const x of comparison){
    console.log(`${String(x.entryGames).padStart(5)} ${(`${(x.threshold*100).toFixed(0)}%`).padStart(9)} ${String(x.qualifiedTeams).padStart(5)} ${String(x.bets).padStart(4)} ${x.winRate.toFixed(2).padStart(6)}% ${money(x.profit).padStart(12)} ${x.roi.toFixed(2).padStart(8)}%`);
  }

  const out=path.join(ROOT,"team-following-season-backtest-results.json");
  fs.writeFileSync(out,JSON.stringify({
    config:{
      stakeSingle:STAKE_SINGLE,minOdds:MIN_ODDS,maxOdds:null,
      entryGames:ENTRY_GAMES,winRateThresholds:WIN_RATE_THRESHOLDS,
      singlesOnly:true,parlays:false,eventualChampionUsed:false,
      noLookAhead:true,qualificationUsesPriorGamesOnly:true,
      firstBetAfterQualification:true,hockeyAfterOTAfterPenLoss:true
    },
    data:{
      totalGames:games.length,
      firstDate:games[0]?.date||null,lastDate:games[games.length-1]?.date||null
    },
    strategyResults:comparison
  },null,2),"utf8");
  console.log(`\nFull diagnostic written to: ${out}`);
}

main();
