# Habit Tracker

Track daily habits, streaks, history and progress statistics. Node.js + Express + SQLite, vanilla JS front-end (installable PWA).

## Features
- Accounts (register, login, change password, delete account), rate-limited and JWT based
- Habits with icon, colour, daily target (times/day), weekdays and reminder time; archive / restore / delete
- Daily check-in (with back-filling of the last 14 days), current and best streaks
- History per habit and statistics: 7/30-day completion, weekly chart, 16-week heat-map
- Export to JSON / CSV, share progress
- Vietnamese and English, light / dark / auto theme, mobile friendly
- Installable (PWA) with offline app shell and in-app reminders (browser notifications)

## Run locally
```bash
npm install
npm start          # http://localhost:8080
npm test
```

## Configuration (environment variables)
| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `./data/habit-tracker.db` | SQLite file (an existing `./habit-tracker.db` from v1 is still used) |
| `JWT_SECRET` | auto-generated | 16+ chars. If unset, a random secret is created once and stored in `data/.jwt_secret` |
| `AUTH_RATE_MAX` | `30` | Max login/register requests per IP per 15 minutes |

## Usage
1. Create an account and log in
2. Add habits (Habits tab)
3. Check them off on the Today tab
4. Follow progress on the Stats tab

## Notes
- Reminders are notifications fired while the app is open or installed; true background push (app closed) needs a push service and is not included.
- Browser notifications and the service worker require HTTPS or `localhost`.

## License
MIT
