import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

/**
 * End-to-end tests against real Postgres and Redis, with the in-memory fake
 * fake provider standing in for the real ones (no network, no spend).
 *
 * Requires the services from docker-compose (or a local install) and a database
 * named `alice_test`.
 */
const WEBHOOK_SECRET = 'e2e-secret';
const ADMIN_KEY = 'e2e-admin-key';

process.env.NODE_ENV = 'test';
process.env.OPENAI_FAKE = 'true';
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_AGENT_ID = '';
process.env.ALICE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST ?? '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT ?? '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER ?? 'alice';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'alice';
process.env.POSTGRES_DB = 'alice_test';
process.env.REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6379';
process.env.FAKE_DELAY_MS = '10';

const webhook = (
  command: string,
  options: { new?: boolean; user?: string; state?: object } = {},
) => ({
  meta: { locale: 'ru-RU', timezone: 'Europe/Moscow', interfaces: { screen: {} } },
  session: {
    session_id: 'e2e-session',
    message_id: 1,
    skill_id: 'e2e-skill',
    application: { application_id: options.user ?? 'e2e-application' },
    new: options.new ?? false,
  },
  request: {
    type: 'SimpleUtterance',
    command,
    original_utterance: command,
    // A field Yandex might add tomorrow: validation must not reject it.
    unexpected_future_field: { nested: true },
  },
  state: options.state ?? {},
  version: '1.0',
});

describe('Alice webhook (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    dataSource = app.get(DataSource);
    await dataSource.runMigrations();
    await dataSource.query('TRUNCATE users, conversations, turn_records RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('health', () => {
    it('GET /health reports the process is alive', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);
      expect(response.body).toMatchObject({ status: 'ok' });
    });

    it('GET /ready checks Postgres and Redis', async () => {
      const response = await request(app.getHttpServer()).get('/ready').expect(200);
      expect(response.body).toEqual({ status: 'ok', postgres: true, redis: true });
    });
  });

  describe('webhook security', () => {
    it('rejects a wrong secret with 403 and no Alice payload', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/alice/wrong-secret')
        .send(webhook('Привет'))
        .expect(403);

      expect(response.body).not.toHaveProperty('response');
    });
  });

  describe('conversation flow', () => {
    const url = `/api/alice/${WEBHOOK_SECRET}`;

    it('greets on skill launch without calling the model', async () => {
      const response = await request(app.getHttpServer())
        .post(url)
        .send(webhook('', { new: true }))
        .expect(200);

      expect(response.body.response.text).toContain('Привет');
      expect(response.body.response.end_session).toBe(false);
      expect(response.body.version).toBe('1.0');
    });

    it('answers a question and persists the session mapping', async () => {
      const response = await request(app.getHttpServer())
        .post(url)
        .send(webhook('Что приготовить из курицы', { user: 'e2e-user-flow' }))
        .expect(200);

      expect(response.body.response.text).toContain('Фейковый ответ');
      expect(response.body.response.tts).toBeDefined();

      const rows = await dataSource.query<
        { provider: string; provider_session_id: string; status: string }[]
      >(
        `SELECT c.provider, c.provider_session_id, c.status FROM conversations c
         JOIN users u ON u.id = c.user_id WHERE u.alice_user_id = $1`,
        ['e2e-user-flow'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('active');
      expect(rows[0].provider_session_id).toMatch(/^sess_fake_/);
      // Every conversation records who produced it, so a later provider switch
      // can tell its own conversations from someone else's.
      expect(rows[0].provider).toBe('responses');
    });

    it('keeps the same session for the next question', async () => {
      await request(app.getHttpServer())
        .post(url)
        .send(webhook('Первый вопрос', { user: 'e2e-user-same-session' }))
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(url)
        .send(webhook('Второй вопрос', { user: 'e2e-user-same-session' }))
        .expect(200);

      // The fake provider counts messages per session: "номер 2" proves the
      // durable session was reused instead of a new one being created.
      expect(second.body.response.text).toContain('номер 2');

      const rows = await dataSource.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM conversations c
         JOIN users u ON u.id = c.user_id WHERE u.alice_user_id = $1`,
        ['e2e-user-same-session'],
      );
      expect(rows[0].count).toBe('1');
    });

    it('starts a new session on "новый разговор" and keeps the old mapping', async () => {
      const user = 'e2e-user-new-conversation';
      await request(app.getHttpServer()).post(url).send(webhook('Первый вопрос', { user }));
      await request(app.getHttpServer()).post(url).send(webhook('новый разговор', { user }));
      const afterReset = await request(app.getHttpServer())
        .post(url)
        .send(webhook('Вопрос в новом разговоре', { user }))
        .expect(200);

      expect(afterReset.body.response.text).toContain('номер 1');

      const rows = await dataSource.query<{ status: string }[]>(
        `SELECT c.status FROM conversations c JOIN users u ON u.id = c.user_id
         WHERE u.alice_user_id = $1 ORDER BY c.created_at`,
        [user],
      );
      expect(rows.map((row) => row.status)).toEqual(['archived', 'active']);
    });

    it('records usage for each turn', async () => {
      const rows = await dataSource.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM turn_records WHERE status = 'completed'`,
      );
      expect(Number(rows[0].count)).toBeGreaterThan(0);
    });

    it('keeps a single active conversation per user even under concurrency', async () => {
      const user = 'e2e-user-concurrent';

      await Promise.all([
        request(app.getHttpServer()).post(url).send(webhook('Вопрос A', { user })),
        request(app.getHttpServer()).post(url).send(webhook('Вопрос B', { user })),
      ]);

      const rows = await dataSource.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM conversations c
         JOIN users u ON u.id = c.user_id WHERE u.alice_user_id = $1 AND c.status = 'active'`,
        [user],
      );
      expect(rows[0].count).toBe('1');
    });
  });

  describe('admin usage', () => {
    it('requires the API key', async () => {
      await request(app.getHttpServer()).get('/api/admin/usage').expect(401);
      await request(app.getHttpServer())
        .get('/api/admin/usage')
        .set('Authorization', 'Bearer wrong')
        .expect(401);
    });

    it('returns aggregates from locally stored turns', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/admin/usage')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .expect(200);

      expect(response.body).toMatchObject({
        today: { requests: expect.any(Number) },
        month: { requests: expect.any(Number) },
        models: expect.any(Array),
        conversations: expect.any(Number),
        pendingTurns: expect.any(Number),
      });
      expect(response.body.today.requests).toBeGreaterThan(0);
    });
  });
});
