import { RealFetcher } from '../data-bridge/realFetcher';

const fetcher = new RealFetcher();
fetcher.fetchSport('tennis').then(r => console.log(r));