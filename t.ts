import { loadConfig } from './src/core/config.js';
import { Session, sessionStatePath } from './src/lastfm/session.js';
const cfg = loadConfig();
const s = new Session({ username: cfg.username, password: cfg.password, userAgent: cfg.userAgent }, { statePath: sessionStatePath(cfg.dbPath) });
await s.ensureSession();
for (const p of [
  '/user/dankjankem/library/music/+noredirect/The+Replacements/_/Unsatisfied',
  '/user/dankjankem/library/music/The+Replacements/_/Unsatisfied',
]) {
  const r = await s.request(p);
  const b = await r.text();
  console.log('\n=====', p, '->', r.status, 'len', b.length);
  const t = /<title[^>]*>([^<]*)<\/title>/.exec(b); console.log('title:', t?.[1]?.trim());
  for (const pat of [/There was a problem[^<.]{0,60}/, /no scrobbles[^<.]{0,60}/i, /class="[^"]*empty[^"]*"/, /<h1[^>]*>([^<]{0,80})/]) {
    const m = pat.exec(b); if (m) console.log('  match:', JSON.stringify(m[0].slice(0,100)));
  }
  console.log('  chartlist count:', (b.match(/chartlist/g) ?? []).length, '| data-edit-scrobble:', (b.match(/data-edit-scrobble/g) ?? []).length);
}
