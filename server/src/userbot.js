import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startUserbot() {
  const userbotPath = path.join(__dirname, '../../userbot');
  
  console.log('Starting user-bot...');
  
  const userbot = spawn('python3', ['bot.py'], {
    cwd: userbotPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  userbot.stdout.on('data', (data) => {
    console.log(`[USERBOT] ${data.toString().trim()}`);
  });

  userbot.stderr.on('data', (data) => {
    console.error(`[USERBOT ERROR] ${data.toString().trim()}`);
  });

  userbot.on('close', (code) => {
    console.log(`[USERBOT] Process exited with code ${code}`);
    // Restart after 10 seconds
    setTimeout(() => {
      console.log('[USERBOT] Restarting...');
      startUserbot();
    }, 10000);
  });

  return userbot;
}
