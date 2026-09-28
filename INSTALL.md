# Installation Guide for Habit Tracker

## Prerequisites
- Docker installed on your machine
- Docker Compose installed on your machine

## Steps
1. Clone the repository
2. Navigate to the project directory
3. Run `docker-compose up -d`
4. Access the application at `http://localhost:18080`

## Without Docker
1. Install Node.js 18+
2. `npm install`
3. `npm start` and open `http://localhost:8080`

## Configuration
- Environment variables: `PORT`, `DB_PATH`, `JWT_SECRET` (optional), `AUTH_RATE_MAX` (see README)
- If `JWT_SECRET` is not set a random one is generated and stored in the data volume
- Data (SQLite database) is stored in the `habit_data` volume (`/usr/src/app/data`); back it up to keep your habits
- `config_options.yml` is unchanged (SoloHost form, no fields)

## Upgrading from 1.x
- Your existing database is migrated automatically and no data is lost
- Everyone must log in once again (the old hard-coded token secret is no longer accepted)

## Troubleshooting
- If the application does not start, check the logs using `docker-compose logs`
- Ensure the ports are not already in use
