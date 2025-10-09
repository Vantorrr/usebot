#!/usr/bin/env python3
print("🔥 USERBOT STARTING...")
print("Python version:", __import__('sys').version)
print("Current directory:", __import__('os').getcwd())
print("Files in directory:", __import__('os').listdir('.'))

try:
    import bot
    print("✅ bot.py imported successfully")
except Exception as e:
    print(f"❌ Failed to import bot.py: {e}")

print("🚀 Starting main bot...")
import bot
