#!/usr/bin/env python3
"""
Генератор StringSession для Telethon user-бота
Запустите локально и добавьте полученную строку в USERBOT_SESSION
"""

import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession

API_ID = input("Введите TELEGRAM_API_ID: ")
API_HASH = input("Введите TELEGRAM_API_HASH: ")

async def main():
    client = TelegramClient(StringSession(), API_ID, API_HASH)
    await client.start()
    
    print("\n" + "="*50)
    print("✅ Успешно! Скопируйте эту строку в USERBOT_SESSION:")
    print("="*50)
    print(client.session.save())
    print("="*50)
    
    me = await client.get_me()
    print(f"Аккаунт: {me.first_name} (@{me.username})")
    
    await client.disconnect()

if __name__ == '__main__':
    asyncio.run(main())
