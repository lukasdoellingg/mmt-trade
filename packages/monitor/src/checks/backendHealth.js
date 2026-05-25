/**
 * HTTP health / ready probes.
 */

/**
 * @param {string} baseUrl e.g. http://localhost:3001
 */
export async function checkBackendHealth(baseUrl) {
  const healthUrl = `${baseUrl.replace(/\/$/, '')}/health`;
  const readyUrl = `${baseUrl.replace(/\/$/, '')}/ready`;
  const out = { healthOk: false, readyOk: false, health: null, ready: null, error: null };

  try {
    const healthRes = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    out.healthOk = healthRes.ok;
    out.health = await healthRes.json();
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }

  try {
    const readyRes = await fetch(readyUrl, { signal: AbortSignal.timeout(5000) });
    out.readyOk = readyRes.ok;
    out.ready = await readyRes.json();
  } catch (e) {
    out.error = out.error || (e instanceof Error ? e.message : String(e));
  }

  return out;
}
