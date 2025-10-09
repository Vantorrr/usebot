#!/usr/bin/env python3
import time
import os

print("🔥 MINIMAL TEST STARTING...")
print("Environment variables:")
print(f"DATABASE_URL: {'SET' if os.getenv('DATABASE_URL') else 'MISSING'}")
print(f"TELEGRAM_API_ID: {os.getenv('TELEGRAM_API_ID', 'MISSING')}")

for i in range(10):
    print(f"Test loop {i+1}/10")
    time.sleep(2)

print("✅ Test completed successfully!")
