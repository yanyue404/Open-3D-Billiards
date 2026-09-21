import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish } from 'gh-pages';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, '.gh-pages-dist');

const copies = [
  ['index.html', 'index.html'],
  ['src', 'src'],
  ['vendor', 'vendor'],
  ['assets', 'assets'],
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const [from, to] of copies) {
  const src = join(root, from);
  if (!existsSync(src)) {
    console.warn(`[deploy] skip missing: ${from}`);
    continue;
  }
  cpSync(src, join(dist, to), { recursive: true });
  console.log(`[deploy] copy ${from} -> ${to}`);
}

writeFileSync(join(dist, '.nojekyll'), '');
console.log('[deploy] write .nojekyll');

await new Promise((resolve, reject) => {
  publish(
    dist,
    {
      branch: 'gh-pages',
      message: 'deploy: github pages',
      dotfiles: true,
      history: false,
    },
    (err) => (err ? reject(err) : resolve()),
  );
});

rmSync(dist, { recursive: true, force: true });
console.log('[deploy] published to origin/gh-pages');
console.log('[deploy] site: https://yanyue404.github.io/Open-3D-Billiards/');
