import * as fs from 'fs';

const html = fs.readFileSync('bucaramanga-page.html', 'utf8');
const rowBlockRegex = /<tr[^>]*height='38'>([\s\S]*?)<\/tr>/g;
const dateRegex = /color:#444444;'>\s*(\d{1,2}) (\w{3})/;
const scoreRegex = /color:blue;font-size:14px;font-family:monospace;'><b>(\d+):(\d+)<\/b>/;
const titleRegex = /title='([^']+) vs ([^']+)'/;

let i = 0;
let m;
while ((m = rowBlockRegex.exec(html)) !== null) {
  i++;
  const row = m[1];
  const hasDate = dateRegex.test(row);
  const hasScore = scoreRegex.test(row);
  const hasTitle = titleRegex.test(row);
  console.log(`row ${i}: date=${hasDate} score=${hasScore} title=${hasTitle}`);
}
console.log('total rows:', i);
