document.addEventListener('DOMContentLoaded', () => {
  const registerBtn = document.getElementById('register-btn');
  const loginBtn = document.getElementById('login-btn');
  const addHabitBtn = document.getElementById('add-habit-btn');
  const habitForm = document.getElementById('habit-form');
  const habitsList = document.getElementById('habits-list');
  const habitLogs = document.getElementById('habit-logs');
  const habitsUl = document.getElementById('habits');
  const logsUl = document.getElementById('logs');

  let userId = null;
  let token = null;

  registerBtn.addEventListener('click', async () => {
    const username = prompt('Enter username:');
    const password = prompt('Enter password:');
    const email = prompt('Enter email:');
    if (!username || !password) return;

    const response = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email })
    });

    if (response.ok) {
      alert('Registration successful');
    } else {
      alert('Registration failed');
    }
  });

  loginBtn.addEventListener('click', async () => {
    const username = prompt('Enter username:');
    const password = prompt('Enter password:');
    if (!username || !password) return;

    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (response.ok) {
      const data = await response.json();
      token = data.token;
      userId = data.id;
      alert('Login successful');
      document.getElementById('auth').style.display = 'none';
      habitForm.style.display = 'block';
      habitsList.style.display = 'block';
      loadHabits();
    } else {
      alert('Login failed');
    }
  });

  addHabitBtn.addEventListener('click', async () => {
    const name = document.getElementById('habit-name').value;
    const description = document.getElementById('habit-description').value;
    const target = document.getElementById('habit-target').value;
    if (!name) return;

    const response = await fetch('/habits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ user_id: userId, name, description, target: target || 1 })
    });

    if (response.ok) {
      document.getElementById('habit-name').value = '';
      document.getElementById('habit-description').value = '';
      document.getElementById('habit-target').value = '';
      loadHabits();
    } else {
      alert('Failed to add habit');
    }
  });

  async function loadHabits() {
    const response = await fetch(`/habits/${userId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.ok) {
      const habits = await response.json();
      habitsUl.innerHTML = '';
      if (habits.length === 0) {
        habitsUl.innerHTML = '<li style="text-align: center; color: #64748b;">No habits yet. Add your first habit above!</li>';
        return;
      }
      habits.forEach(habit => {
        const li = document.createElement('li');
        li.innerHTML = `
          <div class="habit-header">
            <span class="habit-title">${habit.name}</span>
            <span class="habit-streak">🔥 Streak: ${habit.streak}</span>
          </div>
          <div class="habit-desc">${habit.description || 'No description'} (Target: ${habit.target})</div>
        `;
        
        const completeBtn = document.createElement('button');
        completeBtn.className = 'complete-btn';
        completeBtn.textContent = '✓ Mark Completed';
        completeBtn.addEventListener('click', async () => {
          const date = new Date().toISOString().split('T')[0];
          const res = await fetch(`/habits/${habit.id}/complete`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ user_id: userId, date })
          });

          if (res.ok) {
            loadHabits();
            loadHabitLogs(habit.id);
          } else {
            alert('Failed to mark habit as completed');
          }
        });

        li.appendChild(completeBtn);
        habitsUl.appendChild(li);
      });
    }
  }

  async function loadHabitLogs(habitId) {
    const response = await fetch(`/habits/${habitId}/logs`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.ok) {
      const logs = await response.json();
      habitLogs.style.display = 'block';
      logsUl.innerHTML = '';
      logs.forEach(log => {
        const li = document.createElement('li');
        li.textContent = `Completed on ${log.date}`;
        logsUl.appendChild(li);
      });
    }
  }
});
