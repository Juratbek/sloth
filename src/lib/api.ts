export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * POST + JSON both ways; a `{ error }` body from the server becomes the thrown message.
 *
 * Not every answer is JSON, which is the whole reason for the `try`: the API replies `not found`,
 * `cross-site request blocked` and — for anything a handler throws — `String(e)`, all as plain text.
 * Parsing those threw `SyntaxError: Unexpected token 'o'` and that is what the user was shown, in place
 * of the server saying exactly what was wrong. What the server wrote is thrown instead.
 */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: { error?: string };
  try {
    data = text ? (JSON.parse(text) as { error?: string }) : {};
  } catch {
    throw new Error(res.ok ? `${url} answered ${res.status} with something that is not JSON` : `${res.status} ${text.trim()}`);
  }
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${text}`);
  return data as T;
}
