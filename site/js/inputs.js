// Loading a file from a drop zone or a URL. There is no backend, so a URL only
// works when the server sends CORS headers or the user supplies their own proxy.

const PROXY_KEY = 'tmv.corsProxy';

export function getProxy() {
  try { return localStorage.getItem(PROXY_KEY) || ''; } catch (e) { return ''; }
}

export function setProxy(value) {
  try {
    if (value) localStorage.setItem(PROXY_KEY, value);
    else localStorage.removeItem(PROXY_KEY);
  } catch (e) { /* private browsing */ }
}

export class CorsError extends Error {}

export async function fetchUrl(url, onProgress) {
  const proxy = getProxy();
  const target = proxy ? proxy + url : url;
  let res;
  try {
    res = await fetch(target, { redirect: 'follow' });
  } catch (e) {
    throw new CorsError(
      `The browser could not fetch ${url}. Almost always this is CORS: the server does not send ` +
      'Access-Control-Allow-Origin, and a page with no backend cannot work around that. ' +
      'Download the file yourself and drop it in, or point the CORS proxy setting at a proxy you run.');
  }
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return await res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(total ? received / total : null, received);
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}

export function readFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error(`Could not read ${file.name}`));
    if (onProgress) fr.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total, e.loaded); };
    fr.readAsArrayBuffer(file);
  });
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
