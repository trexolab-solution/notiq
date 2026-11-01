// Notiq Autofill — passkeys (experimental): pure helpers for the service worker (and the unit tests).
// Loaded after shared.js (importScripts in the Chromium service worker; listed in background.scripts in the
// Firefox build). No DOM, no network, no secrets: the private keys stay in the Notiq app.
//
// The page-side pieces are passkey-page.js (MAIN world: wraps navigator.credentials) and passkey-bridge.js
// (isolated world: forwards to the background). Both are registered only while the user has turned on
// "Save and use passkeys with Notiq (experimental)" in the popup.
(function (g) {
  "use strict";
  const S = g.NotiqShared;

  const B64U = /^[A-Za-z0-9_-]*$/;
  const MAX = { id: 1366, userId: 86, challenge: 1366, list: 64, name: 256, clientData: 4096, reply: 8192 };
  // A domain as an RP ID: lower-case labels, no empty label, no leading/trailing dash.
  const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
  const isIp = (h) => h.includes(":") || /^[\d.]+$/.test(h);

  const b64uOk = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && B64U.test(s);
  const cleanName = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX.name) : "");

  // A page origin passkeys may be used on: https with a domain, or http://localhost (WebAuthn's secure
  // contexts minus IP addresses, which can never be an RP ID). Returns { origin, host } or null.
  function passkeyOrigin(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (!DOMAIN.test(host) || isIp(host)) return null;
    if (u.protocol !== "https:" && !(u.protocol === "http:" && host === "localhost")) return null;
    return { origin: u.origin, host };
  }

  // The WebAuthn RP ID rule: the RP ID is the origin's host or a registrable domain suffix of it (a parent
  // domain that is not itself a public suffix, Public Suffix List based). `localhost` only matches itself.
  function rpIdValid(rpId, host) {
    if (typeof rpId !== "string" || typeof host !== "string" || !DOMAIN.test(rpId) || !DOMAIN.test(host)) return false;
    if (isIp(rpId) || isIp(host)) return false;
    if (rpId === host) return rpId === "localhost" || S.publicSuffix(rpId) !== rpId;
    if (rpId === "localhost" || host === "localhost" || host.endsWith(".localhost")) return false;
    return host.endsWith(`.${rpId}`) && S.publicSuffix(rpId) !== rpId;
  }

  // The spec's JSON-compatible serialization of the client data (key order matters to some verifiers).
  function clientDataJSON(type, challenge, origin) {
    return JSON.stringify({ type, challenge, origin, crossOrigin: false });
  }

  const utf8b64u = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  function idList(v) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > MAX.list) return null;
    for (const x of v) if (!b64uOk(x, MAX.id)) return null;
    return v.slice();
  }

  // What passkey-page.js sends for navigator.credentials.create({publicKey}), already turned into plain data:
  // { challenge, rp:{id?, name}, user:{id, name, displayName}, algs:[int], exclude:[id], credProps }.
  // Returns { rpId, app: <request for the app, without op/clientDataJSON>, challenge, credProps } or { error }.
  function createRequest(o, page) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "bad_request" };
    if (!b64uOk(o.challenge, MAX.challenge)) return { error: "bad_request" };
    const rp = o.rp && typeof o.rp === "object" ? o.rp : {};
    const rpId = rp.id === undefined || rp.id === null || rp.id === "" ? page.host : String(rp.id).toLowerCase();
    if (!rpIdValid(rpId, page.host)) return { error: "bad_rp_id" };
    const user = o.user && typeof o.user === "object" ? o.user : null;
    if (!user || !b64uOk(user.id, MAX.userId)) return { error: "bad_request" };
    if (!Array.isArray(o.algs) || o.algs.length > 16 || !o.algs.every((a) => Number.isInteger(a))) return { error: "bad_request" };
    if (o.algs.length && !o.algs.includes(-7)) return { error: "unsupported_alg" };
    const exclude = idList(o.exclude);
    if (!exclude) return { error: "bad_request" };
    return {
      rpId, challenge: o.challenge, credProps: o.credProps === true,
      app: {
        origin: page.origin, rpId, rpName: cleanName(rp.name),
        user: { id: user.id, name: cleanName(user.name), displayName: cleanName(user.displayName) },
        algs: o.algs.slice(), exclude,
      },
    };
  }

  // navigator.credentials.get({publicKey}) as plain data: { challenge, rpId?, allow:[id] }.
  function getRequest(o, page) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "bad_request" };
    if (!b64uOk(o.challenge, MAX.challenge)) return { error: "bad_request" };
    const rpId = o.rpId === undefined || o.rpId === null || o.rpId === "" ? page.host : String(o.rpId).toLowerCase();
    if (!rpIdValid(rpId, page.host)) return { error: "bad_rp_id" };
    const allow = idList(o.allow);
    if (!allow) return { error: "bad_request" };
    return { rpId, challenge: o.challenge, app: { origin: page.origin, rpId, allow } };
  }

  // The full app request for a ceremony; the client data is built here from the frame's real origin (never
  // from anything the page sent besides the challenge). Returns { req, clientData } or { error }.
  function appRequest(kind, options, page) {
    const r = kind === "create" ? createRequest(options, page) : kind === "get" ? getRequest(options, page) : { error: "bad_request" };
    if (r.error) return r;
    const clientData = clientDataJSON(kind === "create" ? "webauthn.create" : "webauthn.get", r.challenge, page.origin);
    if (clientData.length > MAX.clientData) return { error: "bad_request" };
    const req = { op: kind === "create" ? "passkey_create" : "passkey_get", ...r.app, clientDataJSON: utf8b64u(clientData) };
    return { req, clientData: req.clientDataJSON, credProps: r.credProps === true };
  }

  // The app's answers, strictly validated; anything else is null (the page then falls back to the browser).
  function validCreateReply(res) {
    if (!res || res.ok !== true) return null;
    if (!b64uOk(res.credentialId, MAX.id) || !b64uOk(res.attestationObject, MAX.reply) || !b64uOk(res.authenticatorData, MAX.reply)
      || !b64uOk(res.publicKey, 400) || res.alg !== -7) return null;
    return { credentialId: res.credentialId, attestationObject: res.attestationObject, authenticatorData: res.authenticatorData,
      publicKey: res.publicKey, alg: -7 };
  }
  function validGetReply(res, allow) {
    if (!res || res.ok !== true) return null;
    if (!b64uOk(res.credentialId, MAX.id) || !b64uOk(res.authenticatorData, MAX.reply) || !b64uOk(res.signature, 200)) return null;
    if (res.userHandle !== "" && !b64uOk(res.userHandle, MAX.userId)) return null;
    if (Array.isArray(allow) && allow.length && !allow.includes(res.credentialId)) return null;
    return { credentialId: res.credentialId, authenticatorData: res.authenticatorData, signature: res.signature,
      userHandle: res.userHandle || "" };
  }

  // What the page gets for an app answer: the credential, `excluded` (InvalidStateError: the vault already
  // holds this account's passkey and the user saw that), or `fallback` (use the browser's own dialog).
  function pageResult(kind, res, sent) {
    if (res && res.error === "excluded" && kind === "create") return { error: "excluded" };
    if (kind === "create") {
      const c = validCreateReply(res);
      return c ? { ok: true, credential: { ...c, clientDataJSON: sent.clientData, credProps: sent.credProps } } : { fallback: true };
    }
    const c = validGetReply(res, sent.req.allow);
    return c ? { ok: true, credential: { ...c, clientDataJSON: sent.clientData } } : { fallback: true };
  }

  // May a frame use Notiq passkeys? The top frame, or a subframe of the very same origin whose every ancestor
  // is that origin too (so the client data is never cross-origin). Other frames use the browser's dialog.
  function frameOk(frameId, frameOrigin, topOrigin, ancestors) {
    if (typeof frameOrigin !== "string" || frameOrigin !== topOrigin) return false;
    if (frameId === 0) return true;
    return Array.isArray(ancestors) && ancestors.length > 0 && ancestors.length <= 32 && ancestors.every((a) => a === topOrigin);
  }

  const api = Object.freeze({ passkeyOrigin, rpIdValid, clientDataJSON, appRequest, validCreateReply, validGetReply, pageResult, frameOk });
  try {
    Object.defineProperty(g, "NotiqPasskeys", { value: api, writable: false, configurable: false, enumerable: false });
  } catch { /* already defined */ }
})(typeof globalThis !== "undefined" ? globalThis : self);
