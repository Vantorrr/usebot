#!/usr/bin/env python3
print("🔥 USERBOT STARTING...")
print("Python version:", __import__('sys').version)
print("Current directory:", __import__('os').getcwd())
print("Files in directory:", __import__('os').listdir('.'))

try:
    print("🚀 Starting main bot...")
    import asyncio
    from bot import main
    asyncio.run(main())
except Exception as e:
    print(f"❌ Fatal error: {e}")
    import traceback
    traceback.print_exc()
