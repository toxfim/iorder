import { createHmac } from 'node:crypto';

/** FAKE token for tests only. */
export const FAKE_BOT_TOKEN = '424242:FAKE-token-for-integration-tests';

/**
 * Builds a correctly signed Mini App init data string, independently of the production
 * verifier (so a shared bug cannot hide itself).
 */
export function signedInitData(options: {
  telegramUserId: string | bigint;
  now: Date;
  /** Seconds before `now` that the data was issued. */
  ageSeconds?: number;
  token?: string;
  firstName?: string;
}): string {
  const authDate = Math.floor(options.now.getTime() / 1000) - (options.ageSeconds ?? 0);
  const fields: [string, string][] = [
    ['auth_date', String(authDate)],
    ['query_id', 'AAH-integration'],
    [
      'user',
      JSON.stringify({
        id: Number(options.telegramUserId),
        first_name: options.firstName ?? 'Tester',
        language_code: 'uz',
      }),
    ],
  ];
  const secret = createHmac('sha256', 'WebAppData')
    .update(options.token ?? FAKE_BOT_TOKEN)
    .digest();
  const dataCheckString = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams([...fields, ['hash', hash]]).toString();
}

export const tma = (initData: string): Record<string, string> => ({
  authorization: `tma ${initData}`,
});
