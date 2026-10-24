# Live Scores

A real-time scoreboard for college football (FBS and FCS), the NFL, and the NHL.
Plain HTML, CSS, and JavaScript. No build step, no backend, no API key. The browser calls ESPN's
public endpoints directly (they send `Access-Control-Allow-Origin: *`).

## Run it

```
cd scores-app
py -m http.server 8765
```

Then open <http://localhost:8765/>. Opening `index.html` straight from the file system also works
in most browsers, but a local server is the reliable option.

## What it does

- Three leagues in one place, switched with tabs or the 1 / 2 / 3 keys.
- Live games first, with a pulsing clock, possession marker, down and distance, red-zone and
  timeout indicators, and the last play. Score changes flash and show a "+7" style chip.
- "Close" and "Upset watch" tags on live games, and a "Closest games" sort.
- A cross-league live strip at the top so a hockey game in progress shows while you watch football.
- Week picker (football) and day or weekend picker (hockey), with previous / next buttons and the
  [ ] keys. The URL hash holds the view, so it can be bookmarked or shared.
- Filters: division (FBS, FCS, both), conference (AFC / NFC for the NFL), Top 25 only, starred
  teams only, team search (/). The NFL view lists the teams on bye in the status line.
- Star any team. Starred teams float to the top across all three sports and, with alerts turned on,
  trigger a browser notification when they score or the game ends.
- Click a game for details: period or quarter line score, win-probability chart with hover
  (football), scoring plays, recent plays, team stats, leaders, venue, TV, line, weather, and links
  to ESPN's gamecast.
- Auto refresh every 15 seconds when anything is live, 60 seconds otherwise, paused while the tab
  is hidden. Light and dark themes and a compact layout.
- **Standings view** (T key): conference tables for college football with conference and overall
  records, points for and against, differential and streak; NFL divisions with home, road, division
  and conference splits; NHL divisions with games played, wins, losses, overtime losses, points,
  goals for and against, home, road, last ten and streak. Ranked college teams carry their poll
  rank. The conference dropdown narrows to one conference.
- **Rankings view** (P key): AP Top 25, AFCA Coaches, and FCS Coaches polls for college football,
  with movement since the last poll, points, first-place votes, others receiving votes, and teams
  that dropped out. Not shown for the NFL or NHL.
- Clicking a team in either view jumps back to Scores filtered to that team.

## Notes

- ESPN's `groups` filter for college football uses the same IDs as the team `conferenceId`
  field: 1 ACC, 4 Big 12, 5 Big Ten, 8 SEC, 9 Pac-12, 12 CUSA, 15 MAC, 17 Mountain West,
  18 Independents, 37 Sun Belt, 151 American, 80 FBS, 81 FCS. The app builds the conference list
  from the standings endpoint at startup rather than hardcoding it, and caches it for a week.
- Date ranges (`dates=YYYYMMDD-YYYYMMDD`) currently fail on ESPN's side, so the weekend view
  fetches each day separately and merges them.
- NHL standings need `level=3` on the standings endpoint to include divisions.
- This is unofficial. Keep the refresh interval reasonable to stay a good citizen.
