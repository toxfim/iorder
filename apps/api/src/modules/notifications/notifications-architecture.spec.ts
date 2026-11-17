import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module rules for the bot and the notification sender, checked on the source.
const SRC = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));
const inModule = (name: string) => files.filter((f) => f.path.startsWith(`modules/${name}/`));

describe('the Telegram and notifications modules', () => {
  it('only the telegram module imports grammy', () => {
    const offenders = files.filter((f) => /from 'grammy/.test(f.text)).map((f) => f.path);
    expect(offenders.every((p) => p.startsWith('modules/telegram/'))).toBe(true);
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('use other modules only through their index (no repository or table access)', () => {
    for (const name of ['telegram', 'notifications']) {
      for (const file of inModule(name)) {
        const imports = [...file.text.matchAll(/from '(\.\.\/[^']+)'/g)].map((m) => m[1] ?? '');
        for (const target of imports) {
          const crossModule = /^\.\.\/(identity|organizations|orders|audit|pricing|catalog)\//.test(
            target,
          );
          if (crossModule) expect(target, file.path).toMatch(/\/index\.js$/);
        }
      }
    }
  });

  it('writes the outbox only from the notifications repository (delivery columns), the orders repository (inserts), the staff notices helper (inserts), the group-removal helper (inserts) and the price list post helper (inserts)', () => {
    const writers = files
      .filter((f) =>
        /UPDATE\s+notification_outbox|notificationOutbox\.(update|updateMany|create|createMany|delete)/i.test(
          f.text,
        ),
      )
      .map((f) => f.path)
      .sort();
    expect(writers).toEqual([
      'common/outbox/kick-member.ts',
      'common/outbox/price-list-post.ts',
      'common/outbox/staff-notices.ts',
      'modules/notifications/outbox.repository.ts',
      'modules/orders/orders.repository.ts',
    ]);
  });

  it('the dispatcher never writes message text or error bodies to the database', () => {
    const repository =
      files.find((f) => f.path === 'modules/notifications/outbox.repository.ts')?.text ?? '';
    // Only fixed codes (DeliveryErrorCode) are written as last_error_code; no free text parameter.
    expect(repository).not.toMatch(/\btext\b\s*[:=]/);
    expect(repository.match(/last_error_code = \$\{code\}/g)?.length).toBeGreaterThan(0);
  });

  it('the two webhook controllers are the only public Telegram routes', () => {
    const routes = files.filter(
      (f) => /@Public\(\)/.test(f.text) && f.path.startsWith('modules/telegram/'),
    );
    // The main bot's webhook and the staff bot's ([C] 2026-11-10); both check the secret proof.
    expect(routes.map((f) => f.path).sort()).toEqual([
      'modules/telegram/staff-bot/staff-bot-webhook.controller.ts',
      'modules/telegram/telegram-webhook.controller.ts',
    ]);
  });
});
