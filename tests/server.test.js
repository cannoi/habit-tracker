const request = require('supertest');
const app = require('../server');

describe('Habit Tracker API', () => {
  it('should return health check', async () => {
    const res = await request(app)
      .get('/health');
    expect(res.statusCode).toEqual(200);
    expect(res.text).toBe('OK');
  });

  it('should register a new user', async () => {
    const res = await request(app)
      .post('/register')
      .send({
        username: 'testuser',
        password: 'testpass',
        email: 'test@example.com'
      });
    expect(res.statusCode).toEqual(201);
    expect(res.body).toHaveProperty('id');
  });

  it('should login a user', async () => {
    const res = await request(app)
      .post('/login')
      .send({
        username: 'testuser',
        password: 'testpass'
      });
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('token');
  });
});