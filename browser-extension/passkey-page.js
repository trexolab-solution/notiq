// Notiq Autofill — passkeys (experimental), page side. Runs in the page's MAIN world at document_start, and is
// registered only while "Save and use passkeys with Notiq (experimental)" is on (see background.js, "Passkeys").
//
// Wraps navigator.credentials.create / get for `publicKey` requests only. The request is turned into plain data
// and posted to passkey-bridge.js (the extension's isolated world in this same window); the background builds
// the client data from the frame's real origin and asks Notiq, which always asks the user. When Notiq declines,
// isn't running, has no passkey for the site, or anything is off, the browser's own implementation runs with
// the original options, so the platform authenticator or a security key still work.
//
// Nothing here is trusted by the extension: the page could post the same messages itself, and would get exactly
// what calling navigator.credentials gives it. Origins, RP IDs and the user's approval are checked elsewhere.
(() => {
  "use strict";
  const W = window;
  const CC = W.CredentialsContainer;
  const PKC = W.PublicKeyCredential;
  if (!CC || !PKC || !CC.prototype || typeof CC.prototype.create !== "function" || W.__notiqPasskeys) return;
  try { Object.defineProperty(W, "__notiqPasskeys", { value: true }); } catch { return; }

  const TAG = "notiq-passkey";
  const nativeCreate = CC.prototype.create;
  const nativeGet = CC.prototype.get;
  const post = W.postMessage.bind(W);
  const origin = W.location.origin;
  const AttResp = W.AuthenticatorAttestationResponse;
  const AsrResp = W.AuthenticatorAssertionResponse;
  const pending = new Map();

  // ---------- bytes ----------
  function bytesOf(buf) {
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    throw new TypeError("not a BufferSource");
  }
  function toB64u(buf) {
    const b = bytesOf(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fromB64u(s) {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  const ids = (list) => (Array.isArray(list) ? list.filter((c) => c && (c.type === undefined || c.type === "public-key")).map((c) => toB64u(c.id)) : []);

  // ---------- options -> plain data (throws on anything odd: the browser then handles it) ----------
  function createData(pk) {
    const sel = pk.authenticatorSelection || {};
    // The site asks for a roaming key (security key / phone): not us.
    if (sel.authenticatorAttachment === "cross-platform") throw new Error("cross-platform");
    const params = Array.isArray(pk.pubKeyCredParams) ? pk.pubKeyCredParams : [];
    return {
      challenge: toB64u(pk.challenge),
      rp: { id: pk.rp && pk.rp.id !== undefined ? String(pk.rp.id) : undefined, name: pk.rp ? String(pk.rp.name || "") : "" },
      user: { id: toB64u(pk.user.id), name: String(pk.user.name || ""), displayName: String(pk.user.displayName || "") },
      algs: params.filter((p) => p && p.type === "public-key" && Number.isInteger(p.alg)).map((p) => p.alg),
      exclude: ids(pk.excludeCredentials),
      credProps: !!(pk.extensions && pk.extensions.credProps),
    };
  }
  function getData(pk) {
    return {
      challenge: toB64u(pk.challenge),
      rpId: pk.rpId !== undefined ? String(pk.rpId) : undefined,
      allow: ids(pk.allowCredentials),
    };
  }

  // ---------- results -> PublicKeyCredential-shaped objects ----------
  function credential(id, rawId, response, extensions, json) {
    const cred = {
      id, rawId, type: "public-key", authenticatorAttachment: "platform", response,
      getClientExtensionResults: () => ({ ...extensions }),
      toJSON: () => json,
    };
    try { Object.setPrototypeOf(cred, PKC.prototype); } catch { /* plain object */ }
    return cred;
  }
  function attestation(c) {
    const ext = c.credProps ? { credProps: { rk: true } } : {};
    const transports = ["hybrid", "internal"];
    const response = {
      clientDataJSON: fromB64u(c.clientDataJSON),
      attestationObject: fromB64u(c.attestationObject),
      getTransports: () => transports.slice(),
      getAuthenticatorData: () => fromB64u(c.authenticatorData),
      getPublicKey: () => fromB64u(c.publicKey),
      getPublicKeyAlgorithm: () => -7,
    };
    try { if (AttResp) Object.setPrototypeOf(response, AttResp.prototype); } catch { /* plain object */ }
    return credential(c.credentialId, fromB64u(c.credentialId), response, ext, {
      id: c.credentialId, rawId: c.credentialId, type: "public-key", authenticatorAttachment: "platform",
      response: { clientDataJSON: c.clientDataJSON, attestationObject: c.attestationObject, authenticatorData: c.authenticatorData,
        publicKey: c.publicKey, publicKeyAlgorithm: -7, transports },
      clientExtensionResults: ext,
    });
  }
  function assertion(c) {
    const response = {
      clientDataJSON: fromB64u(c.clientDataJSON),
      authenticatorData: fromB64u(c.authenticatorData),
      signature: fromB64u(c.signature),
      userHandle: c.userHandle ? fromB64u(c.userHandle) : null,
    };
    try { if (AsrResp) Object.setPrototypeOf(response, AsrResp.prototype); } catch { /* plain object */ }
    return credential(c.credentialId, fromB64u(c.credentialId), response, {}, {
      id: c.credentialId, rawId: c.credentialId, type: "public-key", authenticatorAttachment: "platform",
      response: { clientDataJSON: c.clientDataJSON, authenticatorData: c.authenticatorData, signature: c.signature,
        userHandle: c.userHandle || null },
      clientExtensionResults: {},
    });
  }

  // ---------- the channel to passkey-bridge.js ----------
  W.addEventListener("message", (e) => {
    if (e.source !== W || e.origin !== origin) return;
    const d = e.data;
    if (!d || typeof d !== "object" || d.tag !== TAG || d.dir !== "res" || typeof d.id !== "string") return;
    const done = pending.get(d.id);
    if (done) { pending.delete(d.id); done(d); }
  });

  function ask(kind, options, signal) {
    return new Promise((resolve) => {
      const id = `${kind}-${(W.crypto && W.crypto.randomUUID) ? W.crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
      const finish = (d) => { if (signal) signal.removeEventListener("abort", onAbort); resolve(d); };
      const onAbort = () => { if (pending.delete(id)) finish({ aborted: true }); };
      if (signal) signal.addEventListener("abort", onAbort);
      pending.set(id, finish);
      post({ tag: TAG, dir: "req", id, kind, options }, origin);
    });
  }

  const abortError = (signal) => (signal && signal.reason !== undefined ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));

  async function viaNotiq(kind, self, args, toData, build) {
    const native = kind === "create" ? nativeCreate : nativeGet;
    const options = args[0];
    const pk = options && typeof options === "object" ? options.publicKey : undefined;
    // Not a passkey request, or the passkey autofill UI ("conditional"): the browser's own.
    if (!pk || typeof pk !== "object" || options.mediation === "conditional" || (options.signal && options.signal.aborted)) {
      return native.apply(self, args);
    }
    let data;
    try { data = toData(pk); } catch { return native.apply(self, args); }
    const res = await ask(kind, data, options.signal);
    if (res.aborted) throw abortError(options.signal);
    if (res.ok === true && res.credential) {
      try { return build(res.credential); } catch { /* malformed: fall back */ }
    }
    if (res.error === "excluded") {
      throw new DOMException("The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.", "InvalidStateError");
    }
    return native.apply(self, args);
  }

  function create(...args) { return viaNotiq("create", this, args, createData, attestation); }
  function get(...args) { return viaNotiq("get", this, args, getData, assertion); }
  for (const [name, fn] of [["create", create], ["get", get]]) {
    const d = Object.getOwnPropertyDescriptor(CC.prototype, name) || { writable: true, enumerable: true, configurable: true };
    try { Object.defineProperty(CC.prototype, name, { ...d, value: fn }); } catch { /* leave the browser's */ }
  }
})();
