import * as fs from 'fs';

const html = fs.readFileSync('bucaramanga-page.html', 'utf8');
const rowBlockRegex = /<tr[^>]*height='38'>([\s\S]*?)<\/tr>/g;
const titleRegex = /title='([^']+) vs ([^']+)'/;

let m;
while ((m = rowBlockRegex.exec(html)) !== null) {
  const row = m[1];
  const t = titleRegex.exec(row);
  if (t) console.log(`"${t[1]}" vs "${t[2]}"`);
}
