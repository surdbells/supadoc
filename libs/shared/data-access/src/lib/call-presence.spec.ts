import { sendCallPresence } from './call-presence';

/** Answer the next fetch with `status` and this JSON body. */
function answer(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })),
  );
}

/** One "in" beat; resolves with what the handlers were given once its answer is read. */
async function beat(): Promise<{ refused: unknown[] | null; beats: number }> {
  const seen: { refused: unknown[] | null; beats: number } = { refused: null, beats: 0 };
  sendCallPresence('https://api.test/api/public/call/t/presence', 'in', {}, {
    onBeat: () => seen.beats++,
    onRefused: (...args) => (seen.refused = args),
  });
  await new Promise((r) => setTimeout(r, 0));
  return seen;
}

describe('sendCallPresence', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hands a cancelled / ended consultation to the caller', async () => {
    answer(410, { message: 'Validation failed', errors: { call: 'This consultation was cancelled.', code: 'cancelled' } });
    expect((await beat()).refused).toEqual([410, 'cancelled', 'This consultation was cancelled.']);
  });

  it('hands a doctor refused for their standing (403) to the caller too', async () => {
    answer(403, { message: 'Refused', errors: { call: 'Your VideoMed account is suspended.', code: 'doctor_suspended' } });
    expect((await beat()).refused).toEqual([403, 'doctor_suspended', 'Your VideoMed account is suspended.']);
  });

  it('keeps any other 403 to itself — presence must never disturb the call', async () => {
    answer(403, { message: 'Refused', errors: { call: 'Please accept the notice', code: 'consent_required' } });
    expect((await beat()).refused).toBeNull();
  });

  it('reads an accepted beat', async () => {
    answer(200, { data: { presence: { doctor: true, patient: false, guests: [] }, participants: [] } });
    expect(await beat()).toEqual({ refused: null, beats: 1 });
  });
});
