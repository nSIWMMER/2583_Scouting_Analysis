# Analysis Dashboard

A separate webpage from the scouting app — reads data from the same Google
Sheet (via the Apps Script backend) and adds live data from The Blue Alliance.

```
analysis-page/
├── index.html
├── app.js
└── styles.css
```

## Set up the password

Open `backend/Code.gs` (the one your Apps Script project already runs) and
set:

```js
const ANALYSIS_PASSWORD = 'change-me-analysis-pw';
```

to whatever you want the analysis password to be. Redeploy (**Deploy →
Manage deployments → New version → Deploy**) after changing it.

**Why the password is enforced server-side, not just in this page's UI:**
Anyone can view the source code of a static webpage — so a check like
`if (password === "secret")` written in JavaScript is not real protection,
just a speed bump. Real protection happens in `Code.gs`: without the correct
password, the Apps Script itself refuses to return any data at all, no
matter what request is made. That's why the password lives in two places —
your Apps Script config, and this page's login screen — and why it's a
different value from `SHARED_SECRET` (which is what the *scouting app* uses
to submit new entries; unrelated to reading data here).

Worth being honest about the limit of this approach: it stops casual
snooping and keeps the page from being indexed/browsed by strangers, but a
sufficiently motivated person could still find the Apps Script URL in this
page's source and try passwords against it directly. For a team's own
scouting data this is a reasonable level of protection — it's not bank-grade
security, and shouldn't be treated as such.

## Blue Alliance API key

The TBA read key is already built into `app.js` (`DEFAULT_TBA_KEY`) — scouts
and mentors don't need to enter anything to use the Rankings tab. The
Settings gear still has a TBA key field, but it's now optional: leave it
blank to use the built-in team key, or paste a different one in if you ever
need to override it (e.g. if the built-in key gets rate-limited or rotated).

If you ever need to change the built-in key yourself: get a fresh Read API
Key from [thebluealliance.com/account](https://www.thebluealliance.com/account),
then update the `DEFAULT_TBA_KEY` constant near the top of `app.js`.

## Hosting

Same approach as the scouting app: host this folder's contents somewhere
with HTTPS (Netlify, GitHub Pages — same account, can be a second site or a
subfolder path). It doesn't need to be the same URL/host as the scouting
app, and probably shouldn't be linked from it, since this page has access to
all your team's data across the whole event.

## What's in each tab

**Compare Teams** — dropdown switches between three scatter graphs, one
point per team:
- *Total Fuel Scored*: average of `auto_score + (teleop_score × cycles_per_match)`
  across all of that team's matches
- *Defense Rating*: average `defense_rating` across matches
- *Endgame Climb*: the single best climb level (`L1`/`L2`/`L3`) the team has
  achieved in any match

Click any point to see exactly which team and value it represents (also
shown on hover).

**Team Detail** — pick a team from the dropdown to see:
- A scatter graph of that team's fuel score, one point per match
- A summary table: times broken down, highest endgame climb reached
- Every note and photo submitted for that team, with match/scouter context
- A list of every scout who has submitted an entry for that team

**Event Rankings** — enter a year, load that year's events, then **type into
the search box** to filter by event name (no more scrolling a giant
dropdown) — click a result to load its data. The rankings table now includes:
- **Rank, Team, Record, Played** — straight from TBA's rankings endpoint
- **Ranking Score, Avg Match, Avg Auto Fuel, Avg Tower** — pulled directly
  from TBA's own official per-team ranking statistics (see below)
- **OPR** — from TBA's separate `/event/{key}/oprs` endpoint

Click any column header to sort by it; click again to reverse the order.

## How Avg Match / Avg Auto Fuel / Avg Tower actually work

An earlier version of this page tried to reconstruct these by averaging raw
match data ourselves — that produced numbers slightly off from TBA's own
displayed figures. It turns out TBA already computes these officially, as
part of this year's ranking criteria (visible directly on their event pages,
e.g. thebluealliance.com/event/2026txman shows these exact column names).
TBA's rankings API response includes a `sort_order_info` array that *names*
each entry in a team's `sort_orders` array — so `app.js` looks up "Avg
Match", "Avg Auto Fuel", and "Avg Tower" **by name** in that array, rather
than guessing an index or recomputing from raw matches. This means the
numbers shown should match TBA's website exactly, and the same lookup will
keep working in future seasons even if the exact ranking criteria change,
as long as TBA keeps using descriptive names (which they always have).

## A couple of known limitations worth knowing about

- **Match ordering assumes qual and playoff matches don't collide numerically**
  in a way that matters — the Team Detail graph labels each point using
  match type + number (e.g. "Qual3", "Playoff1"), so they won't overlap
  visually, but it doesn't attempt to sort them chronologically by actual
  time played.
- **Numeric fields are parsed defensively** (`parseFloat`, defaulting to 0
  on anything unexpected) since Google Sheets can store values entered via
  the app as text rather than numbers — this avoids `NaN` showing up in
  calculations, but also means a genuinely malformed entry silently reads
  as zero rather than throwing a visible error.
- **Photos need "Anyone with the link" sharing** to display as thumbnails —
  this is already how `Code.gs` saves them, so it should work automatically,
  but if you ever manually re-share a photo file in Drive with different
  permissions, the thumbnail may stop loading (the raw link will still work
  as a click-through).
