import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { Telegraf } from 'telegraf';
import { startUserbot } from './userbot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.SERVER_PORT || 8080;
let db;

async function initializeDatabase(db) {
  try {
    // Create tables and seed data
    const initSQL = `
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS scenarios (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS scenario_steps (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        step_order INT NOT NULL,
        trigger TEXT,
        message_template TEXT NOT NULL,
        UNIQUE(scenario_id, step_order)
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
        start_time TIME,
        end_time TIME,
        min_pause_sec INT NOT NULL DEFAULT 30,
        max_pause_sec INT NOT NULL DEFAULT 120
      );

      CREATE TABLE IF NOT EXISTS dialog_states (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        scenario_id UUID REFERENCES scenarios(id) ON DELETE SET NULL,
        step_order INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, chat_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS message_templates (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        stage INT NOT NULL,
        variant_name TEXT NOT NULL,
        template TEXT NOT NULL,
        user_type TEXT DEFAULT 'default',
        weight INT DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id BIGINT PRIMARY KEY,
        user_type TEXT DEFAULT 'default',
        first_name TEXT,
        interaction_count INT DEFAULT 0,
        last_response_sentiment TEXT,
        conversion_stage INT DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS conversions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        conversion_type TEXT NOT NULL,
        stage INT NOT NULL,
        variant_used TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO settings (key, value) VALUES
        ('prompt', 'Пиши от лица девушки: тёплый, игривый, уважительный тон; лёгкий флирт и эмодзи умеренно. Отвечай кратко и по-русски. Веди по воронке (1 — приветствие, 2 — прогрев, 3 — оффер, 4 — мягкий CTA), ссылку не давай до шага 4. Соблюдай деликатность, избегай резкости и спама.'),
        ('cta_url', 'https://networkassistant.ai/register?invite_code=USER-170-07548ff71f720f03')
      ON CONFLICT (key) DO NOTHING;
    `;
    
    await db.query(initSQL);
    console.log('Database initialized successfully');
  } catch (error) {
    console.log('Database initialization error:', error.message);
  }
}

// Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Root redirect to admin
app.get('/', (_req, res) => {
  res.redirect('/admin');
});

// Settings: prompt
app.get('/api/settings/prompt', async (_req, res) => {
  try {
    if (!db) {
      return res.json({ prompt: 'Пиши от лица девушки: тёплый, игривый тон. База данных не подключена.' });
    }
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', ['prompt']);
    res.json({ prompt: rows[0]?.value ?? '' });
  } catch (e) {
    res.json({ prompt: 'Ошибка БД: ' + e.message });
  }
});

app.put('/api/settings/prompt', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return res.status(400).json({ error: 'invalid_prompt' });
    }
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      ['prompt', prompt]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_set_prompt' });
  }
});

// Settings: CTA URL
app.get('/api/settings/cta', async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', ['cta_url']);
    res.json({ cta: rows[0]?.value ?? '' });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_get_cta' });
  }
});

app.put('/api/settings/cta', async (req, res) => {
  try {
    const { cta } = req.body || {};
    if (typeof cta !== 'string' || cta.length === 0) {
      return res.status(400).json({ error: 'invalid_cta' });
    }
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      ['cta_url', cta]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_set_cta' });
  }
});

// Scenarios CRUD (basic)
app.get('/api/scenarios', async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM scenarios ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_list_scenarios' });
  }
});

app.post('/api/scenarios', async (req, res) => {
  try {
    const { name, is_active = true, steps = [] } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name_required' });
    const { rows } = await db.query(
      'INSERT INTO scenarios (name, is_active) VALUES ($1, $2) RETURNING *',
      [name, !!is_active]
    );
    const scenario = rows[0];
    // bulk insert steps
    for (const [index, step] of steps.entries()) {
      const { trigger = null, message_template } = step;
      if (!message_template) continue;
      await db.query(
        'INSERT INTO scenario_steps (scenario_id, step_order, trigger, message_template) VALUES ($1, $2, $3, $4)',
        [scenario.id, index, trigger, message_template]
      );
    }
    res.json(scenario);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_create_scenario' });
  }
});

app.get('/api/scenarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query('SELECT * FROM scenarios WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const scenario = rows[0];
    const steps = await db.query(
      'SELECT id, step_order, trigger, message_template FROM scenario_steps WHERE scenario_id = $1 ORDER BY step_order ASC',
      [id]
    );
    res.json({ ...scenario, steps: steps.rows });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_get_scenario' });
  }
});

app.put('/api/scenarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_active } = req.body || {};
    const { rows } = await db.query(
      'UPDATE scenarios SET name = COALESCE($2, name), is_active = COALESCE($3, is_active), updated_at = now() WHERE id = $1 RETURNING *',
      [id, name, is_active]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_update_scenario' });
  }
});

app.delete('/api/scenarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM scenarios WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_delete_scenario' });
  }
});

// Settings: keywords
app.get('/api/settings/keywords', async (_req, res) => {
  try {
    if (!db) return res.json({ keywords: 'знакомства,отношения,пара,любовь' });
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', ['keywords']);
    res.json({ keywords: rows[0]?.value ?? 'знакомства,отношения,пара,любовь' });
  } catch (e) {
    res.json({ keywords: 'Ошибка БД: ' + e.message });
  }
});

app.put('/api/settings/keywords', async (req, res) => {
  try {
    const { keywords } = req.body || {};
    if (typeof keywords !== 'string') {
      return res.status(400).json({ error: 'invalid_keywords' });
    }
    if (!db) return res.json({ ok: false, error: 'no_db' });
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      ['keywords', keywords]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_set_keywords' });
  }
});

// Settings: target chats
app.get('/api/settings/chats', async (_req, res) => {
  try {
    if (!db) return res.json({ chats: '' });
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', ['target_chats']);
    res.json({ chats: rows[0]?.value ?? '' });
  } catch (e) {
    res.json({ chats: 'Ошибка БД: ' + e.message });
  }
});

app.put('/api/settings/chats', async (req, res) => {
  try {
    const { chats } = req.body || {};
    if (typeof chats !== 'string') {
      return res.status(400).json({ error: 'invalid_chats' });
    }
    if (!db) return res.json({ ok: false, error: 'no_db' });
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      ['target_chats', chats]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_set_chats' });
  }
});

// Settings: limits
app.get('/api/settings/limits', async (_req, res) => {
  try {
    if (!db) return res.json({ daily_dm_limit: '7', chat_posts_per_day: '3' });
    const dm_limit = await db.query('SELECT value FROM settings WHERE key = $1', ['daily_dm_limit']);
    const posts_limit = await db.query('SELECT value FROM settings WHERE key = $1', ['chat_posts_per_day']);
    res.json({ 
      daily_dm_limit: dm_limit.rows[0]?.value ?? '7',
      chat_posts_per_day: posts_limit.rows[0]?.value ?? '3'
    });
  } catch (e) {
    res.json({ daily_dm_limit: '7', chat_posts_per_day: '3' });
  }
});

app.put('/api/settings/limits', async (req, res) => {
  try {
    const { daily_dm_limit, chat_posts_per_day } = req.body || {};
    if (!db) return res.json({ ok: false, error: 'no_db' });
    
    if (daily_dm_limit !== undefined) {
      await db.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        ['daily_dm_limit', String(daily_dm_limit)]
      );
    }
    
    if (chat_posts_per_day !== undefined) {
      await db.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        ['chat_posts_per_day', String(chat_posts_per_day)]
      );
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_set_limits' });
  }
});

// Target users list
app.get('/api/target-users', async (_req, res) => {
  try {
    if (!db) return res.json([]);
    const { rows } = await db.query(`
      SELECT user_id, username, first_name, found_in_chat, keyword_matched, status, contacted_at, created_at 
      FROM target_users 
      ORDER BY created_at DESC 
      LIMIT 50
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_get_users' });
  }
});

// Stats (enhanced analytics)
app.get('/api/stats', async (_req, res) => {
  try {
    const dialogs = await db.query('SELECT COUNT(*)::int AS count FROM dialog_states');
    const events = await db.query('SELECT COUNT(*)::int AS count FROM events');
    const conversions = await db.query('SELECT COUNT(*)::int AS count FROM conversions');
    
    // Conversion by stage
    const conversionsByStage = await db.query(`
      SELECT stage, COUNT(*)::int as count 
      FROM conversions 
      GROUP BY stage 
      ORDER BY stage
    `);
    
    // User types distribution
    const userTypes = await db.query(`
      SELECT user_type, COUNT(*)::int as count 
      FROM user_profiles 
      GROUP BY user_type 
      ORDER BY count DESC
    `);
    
    // A/B test performance
    const abPerformance = await db.query(`
      SELECT 
        e.payload->>'variant' as variant,
        e.payload->>'user_type' as user_type,
        COUNT(*)::int as sent,
        COUNT(c.id)::int as conversions
      FROM events e
      LEFT JOIN conversions c ON c.user_id = (e.payload->>'user_id')::bigint
      WHERE e.event_type = 'reply' AND e.payload->>'variant' IS NOT NULL
      GROUP BY e.payload->>'variant', e.payload->>'user_type'
      ORDER BY conversions DESC
    `);
    
    res.json({ 
      dialogs: dialogs.rows[0].count, 
      events: events.rows[0].count,
      conversions: conversions.rows[0].count,
      conversionsByStage: conversionsByStage.rows,
      userTypes: userTypes.rows,
      abPerformance: abPerformance.rows
    });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_get_stats' });
  }
});

// Static admin (minimal React via CDN)
app.use('/admin', express.static(path.join(__dirname, '../public')));

// Telegram admin bot (prompt control) - DISABLED to avoid conflicts
// TODO: Enable after stopping other instances
console.log('Admin bot disabled to avoid conflicts. Use web admin instead.');

async function startServer() {
  try {
    db = getDb();
    await initializeDatabase(db);
    console.log('Database connected and initialized');
  } catch (e) {
    console.log('DB connection failed, using mock data:', e.message);
    db = null;
  }

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    
    // User-bot runs as separate Railway service
    console.log('User-bot should run as separate Railway service');
  });
}

startServer();

// Graceful stop
process.once('SIGINT', () => console.log('Server stopped'));
process.once('SIGTERM', () => console.log('Server stopped'));


