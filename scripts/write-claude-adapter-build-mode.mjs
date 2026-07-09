import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] === 'local' ? 'local' : 'portable';
const outDir = path.resolve(process.cwd(), 'dist/claude-adapter');
const modeFile = path.join(outDir, 'build-mode.json');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(modeFile, `${JSON.stringify({ mode }, null, 2)}\n`, 'utf8');
