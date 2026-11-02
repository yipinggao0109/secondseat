import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const python = process.env.SECONDSEAT_PYTHON || (existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3');
const voice = spawn(python, ['scripts/kokoro_service.py'], { stdio: 'inherit' });
const web = spawn(process.execPath, ['node_modules/vinext/dist/cli.js', 'dev'], { stdio: 'inherit' });

voice.on('exit', (code) => {
  if (code) console.error('Kokoro service did not start. Run scripts/setup_kokoro.sh once, then restart.');
});

function stop() {
  voice.kill('SIGTERM');
  web.kill('SIGTERM');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
web.on('exit', (code) => {
  voice.kill('SIGTERM');
  process.exit(code ?? 0);
});
