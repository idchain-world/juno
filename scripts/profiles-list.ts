import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv, profilesDir } from './profile-env.js';

loadDotEnv();

const root = profilesDir();
if (!fs.existsSync(root)) {
  console.log(`No profiles directory at ${root}`);
  process.exit(0);
}

const slugs = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .sort();

if (slugs.length === 0) {
  console.log(`No profiles found in ${root}`);
  process.exit(0);
}

for (const slug of slugs) {
  const dir = path.join(root, slug);
  const files = ['agent.md', 'soul.md', 'system-prompt.md', 'sources.json', 'tests.json']
    .filter((name) => fs.existsSync(path.join(dir, name)));
  console.log(`${slug}${files.length ? ` (${files.join(', ')})` : ''}`);
}
