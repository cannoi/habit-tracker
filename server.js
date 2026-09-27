const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(bodyParser.json());

// Initialize SQLite database
const db = new sqlite3.Database('./habit-tracker.db');

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, email TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS habits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, description TEXT, target INTEGER, streak INTEGER, created_at TEXT, updated_at TEXT, FOREIGN KEY(user_id) REFERENCES users(id))");
  db.run("CREATE TABLE IF NOT EXISTS habit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER, user_id INTEGER, date TEXT, completed BOOLEAN, created_at TEXT, FOREIGN KEY(habit_id) REFERENCES habits(id), FOREIGN KEY(user_id) REFERENCES users(id))");
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// User registration
app.post('/register', async (req, res) => {
  const { username, password, email } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  db.run("INSERT INTO users (username, password, email) VALUES (?, ?, ?)", [username, hashedPassword, email], function(err) {
    if (err) {
      return res.status(400).send('User already exists');
    }
    res.status(201).send({ id: this.lastID });
  });
});

// User login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err || !user) {
      return res.status(400).send('Cannot find user');
    }
    try {
      if (await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ id: user.id }, 'your_jwt_secret');
        res.status(200).send({ token });
      } else {
        res.status(400).send('Invalid password');
      }
    } catch {
      res.status(500).send('Internal server error');
    }
  });
});

// Add a new habit
app.post('/habits', (req, res) => {
  const { user_id, name, description, target } = req.body;
  const created_at = new Date().toISOString();
  const updated_at = created_at;
  db.run("INSERT INTO habits (user_id, name, description, target, streak, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)", [user_id, name, description, target, created_at, updated_at], function(err) {
    if (err) {
      return res.status(400).send('Error adding habit');
    }
    res.status(201).send({ id: this.lastID });
  });
});

// Mark a habit as completed
app.post('/habits/:id/complete', (req, res) => {
  const habit_id = req.params.id;
  const { user_id, date } = req.body;
  const created_at = new Date().toISOString();
  db.run("INSERT INTO habit_logs (habit_id, user_id, date, completed, created_at) VALUES (?, ?, ?, 1, ?)", [habit_id, user_id, date, created_at], function(err) {
    if (err) {
      return res.status(400).send('Error marking habit as completed');
    }
    // Update streak
    db.run("UPDATE habits SET streak = streak + 1, updated_at = ? WHERE id = ?", [created_at, habit_id], function(err) {
      if (err) {
        return res.status(400).send('Error updating streak');
      }
      res.status(200).send('Habit marked as completed');
    });
  });
});

// Get user habits
app.get('/habits/:user_id', (req, res) => {
  const user_id = req.params.user_id;
  db.all("SELECT * FROM habits WHERE user_id = ?", [user_id], (err, rows) => {
    if (err) {
      return res.status(400).send('Error fetching habits');
    }
    res.status(200).send(rows);
  });
});

// Get habit logs
app.get('/habits/:habit_id/logs', (req, res) => {
  const habit_id = req.params.habit_id;
  db.all("SELECT * FROM habit_logs WHERE habit_id = ?", [habit_id], (err, rows) => {
    if (err) {
      return res.status(400).send('Error fetching habit logs');
    }
    res.status(200).send(rows);
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});