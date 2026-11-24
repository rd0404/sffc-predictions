# SFFC Predictor League

The weekly score-prediction game, replacing the Google Form + Data Prediction + Display Prediction sheets.
Built like the SFFC FPL site: static pages + one Netlify Function, data in Netlify Blobs, fixtures and live scores from the FPL API.

## What's in here
```
public/index.html      player site: Home, Predict, GW Table (+ Compare all), Overall, Stats, Rules
public/admin.html      admin: gameweeks, results, players & passkeys, settings, backup
netlify/functions/api.mjs   the whole API at /api/*
lib/scoring.mjs        points rules (verified against all 337 GW1–10 entries from the sheet)
lib/fpl.mjs            fixtures, deadlines, live scores from FPL
lib/store.mjs          Netlify Blobs storage
lib/mail.mjs           optional Gmail emails
```

## Deploy (once)
1. Create a **new GitHub repo** (e.g. `rd0404/sffc-predictor`) and upload everything in this folder.
   Keep `sffc-history-gw1-10.json` OUT of the repo — it has members' emails.
2. Netlify → **Add new site → Import an existing project → GitHub** → pick the repo.
   Build command: empty. Publish directory: `public` (netlify.toml sets this).
3. **Site configuration → Environment variables**, add:
   - `ADMIN_KEY` — any long password; you type it on /admin.html
   - `GMAIL_USER` and `GMAIL_APP_PASSWORD` — optional, same values as the SFFC site.
     Turns on prediction receipts and the "Email me my passkey" button.
4. Deploy. Open `https://<your-site>.netlify.app/admin.html`.

## First-time setup
1. **Data → Import GW1–10 history** → choose `sffc-history-gw1-10.json`. Adds 36 players and GW1–10, already finalised.
2. **Players → Issue passkeys to everyone without one** → send each person their 6-digit passkey privately
   (or, with Gmail set up, they tap "Email me my passkey" themselves).
3. Add anyone new under Players.

## Every gameweek
1. **Gameweeks → Set up GW n → Load fixtures + deadline from FPL.**
2. Type the two bonus questions (points: B1 = 2, B2 = 3; add a ± range for number questions)
   and the 5 scenarios. Set **Status: Open** → **Save**. Players can predict now.
3. The deadline locks everything automatically. Picks become visible on GW Table → Compare all.
4. Scores update live from FPL while matches are on.
5. After the GW: type the bonus answers, mark each scenario Yes/No → **Save** → **Finalise GW**.
   Finalised GWs are frozen (they won't change if FPL edits data); use **Unlock** only to fix a mistake.

Someone sent picks on WhatsApp? Open the GW → Predictions → **Enter** for that player (works after the deadline too).

## Scoring (same as the old sheet)
| | |
|---|---|
| Exact score (PP) | 3 |
| Goal difference (GD) | 1 |
| Correct winner (CW) | 0.5 |
| Joker | that match's points again |
| Bonus questions | per question (2 and 3); number answers count within ± |
| Scenarios | pick 3 of 5; scenario N = N points if it happens |
| Ties | PP, then GD, then CW |

## Backups
Data → **Download backup** every few weeks. **Restore** loads a backup file back in.
