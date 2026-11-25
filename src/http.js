// -----------------------------------------------------------------------------
// The only network access of the integration: one POST to the incoming
// webhook of the NAS, on node:https (node:http only when the user allowed
// it). A deadline for the whole exchange, a size cap on the answer (checked
// chunk by chunk), no redirect followed (the URL holds the token), no
// connection reused (`agent: false`, and never a custom `createConnection`).
// Taken from gladys-egauge (approved).
//
// The certificate: a NAS reached on the LAN usually shows a self-signed
// certificate. Right after the TLS handshake and BEFORE a single byte of the
// request (its path holds the token) is written, `checkPeer(fingerprint,
// authorized)` decides; what it throws is rethrown marked `notSent`. An answer
// that comes before the request was written is never read. The verification
// by an authority is off for THIS request only (`rejectUnauthorized: false` in
// its own options, the result still given as `authorized`), never for the
// process.
//
// Resolves { status, headers, body } for any status; rejects a ChatError for
// the transport failures, whose message never holds the address nor the URL.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { USER_AGENT } from './constants.js';

export const CODES = {
  CERTIFICATE: 'certificate',
  CERTIFICATE_TYPED: 'certificate_typed',
  TLS: 'tls',
  BAD_ANSWER: 'bad_answer',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  TOO_LARGE: 'too_large',
};

export class ChatError extends Error {
  constructor(code, message, { notSent = false, fingerprint } = {}) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
    this.notSent = notSent;
    if (fingerprint) this.fingerprint = fingerprint;
  }
}

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  const text = String(err?.message ?? '').toLowerCase();
  if (code === 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' || text.includes('handshake failure')) {
    return new ChatError(CODES.TLS, 'TLS handshake refused', { notSent: !sent });
  }
  if (code.startsWith('HPE_') || code === 'EPROTO' || code.startsWith('ERR_SSL')) {
    return new ChatError(CODES.BAD_ANSWER, `Not the expected protocol (${code})`, {
      notSent: !sent,
    });
  }
  return new ChatError(
    CODES.UNREACHABLE,
    /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'Connection failed',
    { notSent: !sent },
  );
}

/**
 * @param {{ scheme: 'https'|'http', host: string, port: number, path: string }} target
 * @param {object} options
 * @param {Buffer} options.body the form body
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} options.maxBytes answer size cap
 * @param {(fingerprint: string, authorized: boolean) => Promise<void>|void} options.checkPeer
 * @param {() => void} [options.onSent] called when the request is written
 */
export function postForm(
  { scheme, host, port, path },
  { body, timeout, maxBytes, checkPeer, onSent },
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let early = false;
    let req = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new ChatError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`, {
            notSent: !sent,
          }),
        ),
      timeout,
    );

    const write = () => {
      sent = true;
      onSent?.();
      req.end(body);
    };

    /** TLS is up: the certificate first, then the request. */
    const ready = async (socket) => {
      if (settled) return;
      const fingerprint = socket.getPeerCertificate?.()?.fingerprint256 ?? null;
      try {
        if (!fingerprint) throw new ChatError(CODES.BAD_ANSWER, 'No certificate');
        await checkPeer(fingerprint, socket.authorized === true);
        if (settled) return;
        if (early) throw new ChatError(CODES.BAD_ANSWER, 'Answer before the request');
      } catch (err) {
        finish(Object.assign(err, { notSent: true }));
        return;
      }
      write();
    };

    try {
      const options = {
        method: 'POST',
        host,
        port,
        path,
        agent: false,
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          'content-length': String(body.length),
        },
      };
      const tlsMode = scheme === 'https';
      if (tlsMode) {
        // Checked by checkPeer above (authority or confirmed fingerprint).
        options.rejectUnauthorized = false;
        if (!isIP(host)) options.servername = host;
      }
      req = (tlsMode ? https : http).request(options, (res) => {
        // An answer before the request was written: never accepted.
        if (!sent) {
          early = true;
          res.resume();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new ChatError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err, sent)));
      });
      req.on('error', (err) => finish(transportError(err, sent)));
      if (tlsMode) {
        req.on('socket', (socket) => socket.once('secureConnect', () => ready(socket)));
      } else {
        write();
      }
    } catch (err) {
      // https.request throws synchronously on a value it refuses: a failure,
      // never a crash.
      finish(transportError(err, false));
    }
  });
}
