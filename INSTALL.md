# Installation Guide for Habit Tracker

## Prerequisites
- Docker installed on your machine
- Docker Compose installed on your machine

## Steps
1. Clone the repository
2. Navigate to the project directory
3. Run `docker-compose up -d`
4. Access the application at `http://localhost:18080`

## Configuration
- Configure the application using the `config_options.yml` file
- Set the JWT secret key and database path

## Troubleshooting
- If the application does not start, check the logs using `docker-compose logs`
- Ensure the ports are not already in use
