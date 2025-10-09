import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { Telegraf } from 'telegraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.SERVER_PORT || 8080;
let db;
try {
  db = getDb();
} catch (e) {
  console.log('DB connection failed, using mock data');
  db = null;
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
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', ['prompt']);
    res.json({ prompt: rows[0]?.value ?? '' });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_get_prompt' });
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

// Telegram admin bot (prompt control)
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : undefined;
let bot = null;
if (botToken) {
  bot = new Telegraf(botToken);
  bot.start((ctx) => ctx.reply('USEbot admin: /get_prompt, /set_prompt <text>'));
  bot.command('get_prompt', async (ctx) => {
    if (adminId && ctx.from.id !== adminId) return;
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', ['prompt']);
    await ctx.reply(rows[0]?.value ?? '(empty)');
  });
  bot.command('set_prompt', async (ctx) => {
    if (adminId && ctx.from.id !== adminId) return;
    const text = ctx.message.text.replace(/^\/set_prompt\s*/, '');
    if (!text) return ctx.reply('Usage: /set_prompt <text>');
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      ['prompt', text]
    );
    await ctx.reply('Prompt updated.');
  });
  bot.launch().then(() => console.log('Admin bot launched')).catch(console.error);
}

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

// Graceful stop
process.once('SIGINT', () => bot?.stop('SIGINT'));
process.once('SIGTERM', () => bot?.stop('SIGTERM'));


