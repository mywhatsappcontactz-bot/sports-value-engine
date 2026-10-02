require("dotenv").config();
const { fetchViaDartsDatabase } = require("./src/scrapers/shared/dartsDatabaseFetch");

(async () => {
  const html = await fetchViaDartsDatabase("https://www.dartsdatabase.co.uk/display-event.php?eid=25630");
  const idx = html.indexOf("Humphries");
  console.log(html.slice(idx - 300, idx + 700));
})();
