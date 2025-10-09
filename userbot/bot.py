import os
import asyncio
import random
from datetime import datetime, time as dtime
from telethon import TelegramClient, events
from telethon.sessions import StringSession
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

API_ID = int(os.getenv('TELEGRAM_API_ID') or 0)
API_HASH = os.getenv('TELEGRAM_API_HASH')
SESSION = os.getenv('USERBOT_SESSION') or ''

DB = dict(
    host=os.getenv('POSTGRES_HOST'),
    port=int(os.getenv('POSTGRES_PORT') or 5432),
    user=os.getenv('POSTGRES_USER'),
    password=os.getenv('POSTGRES_PASSWORD'),
    dbname=os.getenv('POSTGRES_DB'),
)

MIN_PAUSE = int(os.getenv('MIN_PAUSE_SEC') or 30)
MAX_PAUSE = int(os.getenv('MAX_PAUSE_SEC') or 120)
LLM_MODEL = os.getenv('LLM_MODEL') or 'gpt-4o-mini'
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')

async def get_settings(cur):
    """Get settings from database"""
    settings = {}
    cur.execute("SELECT key, value FROM settings WHERE key IN ('target_chats', 'keywords', 'daily_dm_limit', 'chat_posts_per_day')")
    rows = cur.fetchall()
    for row in rows:
        settings[row['key']] = row['value']
    
    # Parse settings
    targets = [t.strip() for t in (settings.get('target_chats', '') or '').split(',') if t.strip()]
    keywords = [k.strip() for k in (settings.get('keywords', 'знакомства,отношения,пара,любовь') or '').split(',') if k.strip()]
    dm_limit = int(settings.get('daily_dm_limit', '7'))
    posts_limit = int(settings.get('chat_posts_per_day', '3'))
    
    return targets, keywords, dm_limit, posts_limit

def db_conn():
    return psycopg2.connect(cursor_factory=psycopg2.extras.RealDictCursor, **DB)


async def get_prompt(cur):
    cur.execute("SELECT value FROM settings WHERE key = %s", ('prompt',))
    row = cur.fetchone()
    return row['value'] if row else ''

async def get_cta(cur):
    cur.execute("SELECT value FROM settings WHERE key = %s", ('cta_url',))
    row = cur.fetchone()
    return row['value'] if row else ''


async def get_active_scenario(cur):
    cur.execute("SELECT id FROM scenarios WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1")
    row = cur.fetchone()
    return row['id'] if row else None


async def get_step_message(cur, scenario_id, step_order):
    cur.execute(
        "SELECT message_template FROM scenario_steps WHERE scenario_id = %s AND step_order = %s",
        (scenario_id, step_order)
    )
    row = cur.fetchone()
    return row['message_template'] if row else None

async def get_dialog_step(cur, user_id, chat_id):
    cur.execute("SELECT step_order FROM dialog_states WHERE user_id = %s AND chat_id = %s", (user_id, chat_id))
    row = cur.fetchone()
    return row['step_order'] if row else 0

async def get_user_profile(cur, user_id, first_name=''):
    cur.execute("SELECT * FROM user_profiles WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    if not row:
        # Create new profile
        cur.execute(
            "INSERT INTO user_profiles (user_id, first_name) VALUES (%s, %s) RETURNING *",
            (user_id, first_name)
        )
        row = cur.fetchone()
    return dict(row) if row else {}

async def update_user_profile(cur, user_id, **updates):
    set_clause = ', '.join(f"{k} = %s" for k in updates.keys())
    values = list(updates.values()) + [user_id]
    cur.execute(f"UPDATE user_profiles SET {set_clause}, updated_at = now() WHERE user_id = %s", values)

async def detect_user_type(text: str) -> str:
    """Simple sentiment/type detection"""
    text_lower = text.lower()
    
    skeptical_words = ['не верю', 'сомневаюсь', 'развод', 'обман', 'фигня', 'бред', 'не работает']
    playful_words = ['хаха', 'ахах', '😂', '😄', '😊', 'прикольно', 'весело', 'круто']
    serious_words = ['серьёзно', 'важно', 'долгосрочные', 'отношения', 'семья', 'брак']
    
    if any(word in text_lower for word in skeptical_words):
        return 'skeptical'
    elif any(word in text_lower for word in playful_words):
        return 'playful'
    elif any(word in text_lower for word in serious_words):
        return 'serious'
    
    return 'default'

async def get_ab_template(cur, stage: int, user_type: str = 'default'):
    """Get weighted random template for A/B testing"""
    cur.execute(
        """
        SELECT template, variant_name FROM message_templates 
        WHERE stage = %s AND user_type = %s 
        ORDER BY RANDOM() * weight DESC 
        LIMIT 1
        """,
        (stage, user_type)
    )
    row = cur.fetchone()
    if row:
        return row['template'], row['variant_name']
    
    # Fallback to default type
    cur.execute(
        """
        SELECT template, variant_name FROM message_templates 
        WHERE stage = %s AND user_type = 'default' 
        ORDER BY RANDOM() * weight DESC 
        LIMIT 1
        """,
        (stage,)
    )
    row = cur.fetchone()
    return (row['template'], row['variant_name']) if row else (None, None)

async def track_conversion(cur, user_id, chat_id, conversion_type, stage, variant_used):
    cur.execute(
        "INSERT INTO conversions (user_id, chat_id, conversion_type, stage, variant_used) VALUES (%s, %s, %s, %s, %s)",
        (user_id, chat_id, conversion_type, stage, variant_used)
    )

async def get_daily_stats(cur):
    cur.execute("SELECT * FROM daily_stats WHERE date = CURRENT_DATE")
    row = cur.fetchone()
    if not row:
        cur.execute("INSERT INTO daily_stats (date) VALUES (CURRENT_DATE) RETURNING *")
        row = cur.fetchone()
    return dict(row)

async def update_daily_stats(cur, field, increment=1):
    cur.execute(f"UPDATE daily_stats SET {field} = {field} + %s WHERE date = CURRENT_DATE", (increment,))

async def find_target_user(cur, user_id, username, first_name, chat_title, keyword):
    cur.execute(
        """INSERT INTO target_users (user_id, username, first_name, found_in_chat, keyword_matched) 
           VALUES (%s, %s, %s, %s, %s) ON CONFLICT (user_id) DO NOTHING""",
        (user_id, username, first_name, chat_title, keyword)
    )

async def get_auto_post_template(cur):
    cur.execute(
        """SELECT template FROM auto_posts 
           WHERE last_used IS NULL OR last_used < NOW() - INTERVAL '24 hours'
           ORDER BY RANDOM() * weight DESC LIMIT 1"""
    )
    row = cur.fetchone()
    if row:
        cur.execute("UPDATE auto_posts SET last_used = NOW() WHERE template = %s", (row['template'],))
        return row['template']
    return None

async def should_contact_user(cur, user_id, dm_limit):
    # Check if already contacted
    cur.execute("SELECT status FROM target_users WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    if row and row['status'] != 'found':
        return False
    
    # Check daily limit
    stats = await get_daily_stats(cur)
    return stats['dms_sent'] < dm_limit

def contains_keywords(text, keywords):
    text_lower = text.lower()
    for keyword in keywords:
        if keyword in text_lower:
            return keyword
    return None


async def inc_dialog_step(cur, user_id, chat_id, scenario_id):
    cur.execute(
        """
        INSERT INTO dialog_states (user_id, chat_id, scenario_id, step_order)
        VALUES (%s, %s, %s, 1)
        ON CONFLICT (user_id, chat_id) DO UPDATE SET step_order = dialog_states.step_order + 1, updated_at = now()
        RETURNING step_order
        """,
        (user_id, chat_id, scenario_id)
    )
    row = cur.fetchone()
    return row['step_order'] if row else 0


async def log_event(cur, event_type, payload):
    cur.execute(
        "INSERT INTO events (event_type, payload) VALUES (%s, %s)",
        (event_type, psycopg2.extras.Json(payload))
    )

def typing_delay_by_text(text: str) -> float:
    base = max(1.0, min(5.0, len(text) / 25.0))
    jitter = random.uniform(0.3, 1.2)
    return base + jitter

def build_system_prompt(base_prompt: str, cta_url: str, stage: int, user_type: str = 'default') -> str:
    persona = (
        'Ты девушка. Пиши от первого лица (женский род), дружелюбно, легко и чуть игриво, '
        'но уважительно. Используй эмодзи умеренно, избегай клише и навязчивости.'
    )
    
    # Адаптация под тип пользователя
    type_adaptations = {
        'skeptical': 'Пользователь скептичен. Будь более доказательной, используй факты, отзывы, статистику. Не давай пустых обещаний.',
        'playful': 'Пользователь игривый. Можешь быть более раскованной, использовать юмор, эмодзи, лёгкий флирт.',
        'serious': 'Пользователь серьёзный. Будь более деловой, говори о долгосрочных отношениях, совместимости, научном подходе.',
        'default': 'Универсальный подход: дружелюбно, но не навязчиво.'
    }
    
    funnel = [
        'Этап 1 — короткое приветствие, лёгкий вопрос, без ссылки.',
        'Этап 2 — прогрев: комплимент, лёгкий юмор, искренний интерес. Без давления.',
        'Этап 3 — оффер: чем полезен сервис знакомств с ИИ (100% совместимость).',
        'Этап 4 — CTA: мягко предложи перейти по ссылке (1–2 минуты). Ссылка: ' + cta_url,
    ]
    
    # Обработка возражений
    objections = {
        'не верю': 'Понимаю скепсис. Покажи статистику или предложи попробовать бесплатно.',
        'нет времени': 'Подчеркни, что займёт 1-2 минуты, результат сразу.',
        'не работает': 'Расскажи про успешные пары, которым помогла.',
        'дорого': 'Скажи, что первичный анализ бесплатный.'
    }
    
    safety = 'Пиши по-русски, кратко, естественно. Не давай ссылку до этапа 4. Избегай резкости и спама.'
    
    return (
        f"{base_prompt}\n\nПерсона: {persona}\n\n"
        f"Тип пользователя: {type_adaptations.get(user_type, type_adaptations['default'])}\n\n"
        f"Воронка:\n- {funnel[0]}\n- {funnel[1]}\n- {funnel[2]}\n- {funnel[3]}\n\n"
        f"Возражения: {'; '.join(f'{k} -> {v}' for k, v in objections.items())}\n\n"
        f"Текущий этап: {stage+1}. {safety}"
    )

async def generate_reply_llm(client_oai: OpenAI, model: str, base_prompt: str, cta_url: str, stage: int, first_name: str, user_text: str, user_type: str = 'default') -> str:
    sys = build_system_prompt(base_prompt, cta_url, stage, user_type)
    name_part = f"{first_name}" if first_name else ""
    messages = [
        {"role": "system", "content": sys},
        {"role": "user", "content": f"Пользователь ({name_part}): {user_text}"},
    ]
    try:
        resp = client_oai.chat.completions.create(model=model, messages=messages, temperature=0.8, max_tokens=140)
        return (resp.choices[0].message.content or '').strip()
    except Exception:
        # fallback minimal (женский тон)
        fallbacks = [
            "Привет! Любишь совпадения? 🙂",
            "У тебя приятный вайб. Хочешь, ИИ подберёт тебе идеальную пару?",
            f"Кину ссылку? Это быстро, 1–2 минуты: {cta_url}",
        ]
        return fallbacks[min(stage, len(fallbacks)-1)]


def within_schedule(cur, scenario_id):
    cur.execute("SELECT start_time, end_time FROM schedules WHERE scenario_id = %s", (scenario_id,))
    rows = cur.fetchall()
    if not rows:
        return True
    now_t = datetime.now().time()
    for r in rows:
        st = r['start_time']
        et = r['end_time']
        if (st is None and et is None) or (st and et and st <= now_t <= et):
            return True
    return False


async def main():
    if not API_ID or not API_HASH:
        raise RuntimeError('TELEGRAM_API_ID / TELEGRAM_API_HASH are required')

    if SESSION:
        client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)
    else:
        client = TelegramClient('userbot.session', API_ID, API_HASH)
    
    try:
        await client.start()
        print(f'User-bot started successfully as {(await client.get_me()).first_name}')
    except Exception as e:
        print(f'Failed to start user-bot: {e}')
        print('User-bot requires phone login. Please provide USERBOT_SESSION string.')
        return

    conn = db_conn()
    conn.autocommit = True
    cur = conn.cursor()

    scenario_id = await get_active_scenario(cur)
    if not scenario_id:
        print('No active scenario; idle.')
    base_prompt = await get_prompt(cur)
    cta_url = await get_cta(cur)
    
    # Get settings from database
    targets, keywords, dm_limit, posts_limit = await get_settings(cur)
    print(f'Settings loaded: {len(targets)} chats, {len(keywords)} keywords, {dm_limit} DMs/day, {posts_limit} posts/day')

    @client.on(events.NewMessage(incoming=True))
    async def handle_message(event):
        try:
            sender = await event.get_sender()
            chat = await event.get_chat()
            user_id = getattr(sender, 'id', None)
            chat_id = getattr(chat, 'id', None)
            text = event.raw_text or ''
            
            # Skip own messages
            if sender and hasattr(sender, 'bot') and sender.bot:
                return
            if sender and sender.id == (await client.get_me()).id:
                return

            await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'incoming', {
                'user_id': user_id, 'chat_id': chat_id, 'text': text
            })

            # Check for keywords in group chats (proactive search)
            if hasattr(chat, 'title') and chat.title:  # Group chat
                keyword = contains_keywords(text, keywords)
                if keyword and user_id:
                    username = getattr(sender, 'username', '')
                    first_name = getattr(sender, 'first_name', '') or ''
                    
                    # Save potential target
                    await asyncio.get_event_loop().run_in_executor(
                        None, find_target_user, cur, user_id, username, first_name, chat.title, keyword
                    )
                    await asyncio.get_event_loop().run_in_executor(None, update_daily_stats, cur, 'users_found')
                    
                    # Try to contact if within limits
                    if await asyncio.get_event_loop().run_in_executor(None, should_contact_user, cur, user_id, dm_limit):
                        await asyncio.sleep(random.randint(60, 300))  # Wait 1-5 minutes
                        try:
                            # Send first message from scenario
                            template, _ = await get_ab_template(cur, 0, 'default')
                            if template:
                                dm_text = template.replace('{first_name}', first_name).replace('{cta_url}', cta_url)
                                await client.send_message(user_id, dm_text)
                                
                                # Update stats
                                await asyncio.get_event_loop().run_in_executor(None, update_daily_stats, cur, 'dms_sent')
                                cur.execute("UPDATE target_users SET status = 'contacted', contacted_at = NOW() WHERE user_id = %s", (user_id,))
                                
                                await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'proactive_dm', {
                                    'user_id': user_id, 'keyword': keyword, 'text': dm_text
                                })
                        except Exception as e:
                            await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'dm_error', {
                                'user_id': user_id, 'error': str(e)
                            })
                return  # Don't process group messages further

            # Handle private messages (existing logic)
            if not scenario_id:
                return
            if not within_schedule(cur, scenario_id):
                return

            # Get or create user profile
            first_name = getattr(sender, 'first_name', '') or ''
            profile = await get_user_profile(cur, user_id, first_name)
            stage = await get_dialog_step(cur, user_id, chat_id)
            user_text = text
            
            # Detect user type and update profile
            detected_type = await detect_user_type(user_text)
            if detected_type != 'default':
                await update_user_profile(cur, user_id, user_type=detected_type)
                profile['user_type'] = detected_type
            
            user_type = profile.get('user_type', 'default')
            
            # Get A/B template or use LLM
            reply_text = None
            variant_used = None
            
            if OPENAI_API_KEY:
                oai = OpenAI(api_key=OPENAI_API_KEY)
                reply_text = await asyncio.get_event_loop().run_in_executor(
                    None,
                    generate_reply_llm,
                    oai,
                    LLM_MODEL,
                    base_prompt,
                    cta_url,
                    stage,
                    first_name,
                    user_text,
                    user_type,
                )
                variant_used = f'llm_{user_type}'
            
            if not reply_text:
                # Use A/B template
                template, variant_used = await get_ab_template(cur, min(stage, 3), user_type)
                if template:
                    reply_text = template.replace('{first_name}', first_name).replace('{cta_url}', cta_url)
                else:
                    # Final fallback
                    fallback_template = await get_step_message(cur, scenario_id, min(stage, 3))
                    if fallback_template:
                        reply_text = fallback_template.replace('{first_name}', first_name).replace('{cta_url}', cta_url)
                        variant_used = 'fallback'
                    else:
                        return

            await asyncio.sleep(random.randint(MIN_PAUSE, MAX_PAUSE))
            # typing imitation
            async with client.action(event.chat_id, 'typing'):
                await asyncio.sleep(typing_delay_by_text(reply_text))
            await event.reply(reply_text)
            
            # Log and track
            await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'reply', {
                'user_id': user_id, 'chat_id': chat_id, 'text': reply_text, 'variant': variant_used, 'user_type': user_type
            })
            
            # Track potential conversion (CTA stage)
            if stage >= 3 and cta_url in reply_text:
                await asyncio.get_event_loop().run_in_executor(None, track_conversion, cur, user_id, chat_id, 'cta_sent', stage, variant_used)
            
            # Update interaction count and advance stage
            await asyncio.get_event_loop().run_in_executor(None, update_user_profile, cur, user_id, interaction_count=profile.get('interaction_count', 0) + 1)
            await asyncio.get_event_loop().run_in_executor(None, inc_dialog_step, cur, user_id, chat_id, scenario_id)
        except Exception as e:
            await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'error', {'error': str(e)})

    async def scheduler_loop():
        while True:
            try:
                # Refresh settings every loop
                current_targets, current_keywords, current_dm_limit, current_posts_limit = await get_settings(cur)
                
                if not current_targets:
                    await asyncio.sleep(300)  # Wait 5 min if no targets
                    continue
                    
                stats = await asyncio.get_event_loop().run_in_executor(None, get_daily_stats, cur)
                
                # Auto-posting to chats (proactive engagement)
                if stats['posts_made'] < current_posts_limit and within_schedule(cur, scenario_id):
                    auto_post = await asyncio.get_event_loop().run_in_executor(None, get_auto_post_template, cur)
                    if auto_post:
                        target = random.choice(current_targets)
                        try:
                            async with client.action(target, 'typing'):
                                await asyncio.sleep(typing_delay_by_text(auto_post))
                            await client.send_message(target, auto_post)
                            
                            await asyncio.get_event_loop().run_in_executor(None, update_daily_stats, cur, 'posts_made')
                            await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'auto_post', {
                                'target': target, 'text': auto_post
                            })
                        except Exception as e:
                            await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'post_error', {
                                'target': target, 'error': str(e)
                            })
                
                # Regular scenario broadcast (less frequent now)
                elif random.random() < 0.3 and scenario_id and within_schedule(cur, scenario_id):
                    template = await get_step_message(cur, scenario_id, 0)
                    if template:
                        msg = template.replace('{cta_url}', cta_url)
                        target = random.choice(current_targets)
                        try:
                            async with client.action(target, 'typing'):
                                await asyncio.sleep(typing_delay_by_text(msg))
                            await client.send_message(target, msg)
                            await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'broadcast', {'target': target, 'text': msg})
                        except Exception as e:
                            await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'broadcast_error', {'target': target, 'error': str(e)})
                
                # Wait longer between posts (30 min to 2 hours)
                await asyncio.sleep(random.randint(1800, 7200))
            except Exception as e:
                await asyncio.get_event_loop().run_in_executor(None, log_event, cur, 'scheduler_error', {'error': str(e)})
                await asyncio.sleep(300)  # 5 min on error

    await asyncio.gather(client.run_until_disconnected(), scheduler_loop())


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass


