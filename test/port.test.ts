import { afterAll, describe, expect, it } from 'vitest';
import { reloadConfig } from '../server/config';

describe('SLOTH_PORT', () => {
  const was = process.env.SLOTH_PORT;
  afterAll(() => {
    process.env.SLOTH_PORT = was;
    reloadConfig();
  });
  it('falls back to 4400 when the variable is set but blank — `SLOTH_PORT=` in .env is no port', () => {
    // `??` let the empty string through, `Number('')` is 0, and Vite bound a random port the QR code
    // and the launch agent then named wrongly.
    for (const value of ['', '  ']) {
      process.env.SLOTH_PORT = value;
      expect(reloadConfig().port).toBe(4400);
    }
    process.env.SLOTH_PORT = ' 5000 ';
    expect(reloadConfig().port).toBe(5000);
  });
});
