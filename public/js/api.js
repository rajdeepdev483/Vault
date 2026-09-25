// =====================================================================
//  VAULT — thin wrapper around fetch() for talking to the Express API
// =====================================================================
'use strict';

const Api = (() => {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        credentials: 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      const err = new Error('Cannot reach the server. Check your connection and try again.');
      err.isNetwork = true;
      throw err;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      // no JSON body (e.g. some 204s) — that's fine
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || `Something went wrong (${res.status}).`);
      err.status = res.status;
      err.extra = data;
      throw err;
    }
    return data;
  }

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body === undefined ? {} : body),
    patch: (path, body) => call('PATCH', path, body === undefined ? {} : body),
    del: (path) => call('DELETE', path),
  };
})();
