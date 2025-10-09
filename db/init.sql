-- Schema initialization for USEbot
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('prompt', 'Пиши от лица девушки: тёплый, игривый, уважительный тон; лёгкий флирт и эмодзи умеренно. Отвечай кратко и по-русски. Веди по воронке (1 — приветствие, 2 — прогрев, 3 — оффер, 4 — мягкий CTA), ссылку не давай до шага 4. Соблюдай деликатность, избегай резкости и спама.' )
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('cta_url', 'https://networkassistant.ai/register?invite_code=USER-170-07548ff71f720f03')
ON CONFLICT (key) DO NOTHING;

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
  trigger TEXT, -- optional keyword or event name
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

-- Seed example scenario
-- Message templates for A/B testing
CREATE TABLE IF NOT EXISTS message_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  stage INT NOT NULL,
  variant_name TEXT NOT NULL,
  template TEXT NOT NULL,
  user_type TEXT DEFAULT 'default', -- default, skeptical, playful, serious
  weight INT DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User profiles for personalization
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id BIGINT PRIMARY KEY,
  user_type TEXT DEFAULT 'default',
  first_name TEXT,
  interaction_count INT DEFAULT 0,
  last_response_sentiment TEXT, -- positive, neutral, negative
  conversion_stage INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conversion tracking
CREATE TABLE IF NOT EXISTS conversions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id BIGINT NOT NULL,
  chat_id BIGINT NOT NULL,
  conversion_type TEXT NOT NULL, -- click, signup, etc
  stage INT NOT NULL,
  variant_used TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE s_id UUID;
BEGIN
  INSERT INTO scenarios (name) VALUES ('Dating AI Funnel') RETURNING id INTO s_id;
  INSERT INTO scenario_steps (scenario_id, step_order, trigger, message_template) VALUES
    (s_id, 0, 'start', 'Привет, {first_name}! Веришь в идеальные совпадения? 🙂'),
    (s_id, 1, NULL, 'Я помогаю находить пару с ИИ — он подбирает 100% совместимость 💫'),
    (s_id, 2, NULL, 'Хочешь посмотреть, кого ИИ подберёт тебе? Могу дать ссылку.'),
    (s_id, 3, 'cta', 'Вот ссылка: {cta_url} (займёт 1–2 минуты)');
EXCEPTION WHEN unique_violation THEN
  NULL;
END $$;

-- A/B test message variants
INSERT INTO message_templates (stage, variant_name, template, user_type, weight) VALUES
-- Stage 0 (greeting)
(0, 'curious', 'Привет, {first_name}! Любишь совпадения? 🙂', 'default', 3),
(0, 'direct', 'Хей! Как настроение сегодня? ✨', 'playful', 2),
(0, 'mysterious', 'Привет! А ты веришь в судьбу? 🤔', 'serious', 2),
(0, 'skeptical_approach', 'Привет! Не люблю банальности, но у меня есть интересная штука 😏', 'skeptical', 1),

-- Stage 1 (warm-up)
(1, 'compliment', 'У тебя приятный вайб! Расскажи, что ищешь в отношениях? 💭', 'default', 3),
(1, 'playful', 'Улыбка у тебя "совпадающая" 😊 Ты больше про лёгкий флирт или серьёзно?', 'playful', 2),
(1, 'serious', 'Чувствую, ты человек с глубиной. Что для тебя важно в партнёре?', 'serious', 2),
(1, 'skeptical_handle', 'Знаю, звучит как очередная "магия", но это реально работает. Интересно?', 'skeptical', 1),

-- Stage 2 (offer)
(2, 'ai_power', 'Я работаю с ИИ, который анализирует совместимость по 50+ параметрам 🧠✨', 'default', 3),
(2, 'success_story', 'Недавно помогла паре — они встречаются уже 3 месяца! ИИ подобрал идеально 💕', 'playful', 2),
(2, 'scientific', 'Алгоритм учитывает психотип, интересы, стиль общения. Точность 94% 📊', 'serious', 2),
(2, 'proof', 'Покажу скриншоты отзывов, если не веришь. Но лучше сам попробуй 😉', 'skeptical', 1),

-- Stage 3 (CTA)
(3, 'soft', 'Хочешь проверим твою совместимость? Займёт 2 минуты: {cta_url} 💫', 'default', 3),
(3, 'urgent', 'Давай прямо сейчас! Кину ссылку: {cta_url} (быстро и бесплатно) 🚀', 'playful', 2),
(3, 'logical', 'Вот ссылка для анализа: {cta_url}. Результат получишь сразу 📱', 'serious', 2),
(3, 'challenge', 'Не веришь? Тогда точно попробуй: {cta_url} Удивлю! 😏', 'skeptical', 1)

ON CONFLICT DO NOTHING;


