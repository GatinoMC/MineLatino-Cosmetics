import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

function splitAddress(value) {
  const trimmed = value.trim();
  const index = trimmed.lastIndexOf(':');
  if (index > 0 && trimmed.indexOf(':') === index && /^\d+$/.test(trimmed.slice(index + 1))) {
    return { host: trimmed.slice(0, index), port: Number(trimmed.slice(index + 1)) };
  }
  return { host: trimmed };
}

function publicIpv4(host) {
  const parts = host.split('.').map(Number);
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 2, 168].includes(b))
    || (a === 198 && [18, 19, 51].includes(b))
    || (a === 203 && b === 0));
}

export function normalizePublicServerAddress(value) {
  if (typeof value !== 'string' || value.length > 255 || /[\x00-\x20\x7f]/.test(value)) return;
  const { host: rawHost, port } = splitAddress(value.toLowerCase());
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return;
  const host = rawHost.replace(/\.$/, '');
  if (isIP(host) === 4) {
    if (!publicIpv4(host)) return;
  } else {
    if (isIP(host) !== 0) return; // IPv6 is intentionally omitted from this first statistics format.
    const ascii = domainToASCII(host);
    if (!ascii || !ascii.includes('.') || ascii.length > 253
      || ['localhost', 'local', 'lan', 'internal'].some(suffix => ascii === suffix || ascii.endsWith(`.${suffix}`))
      || !ascii.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) return;
    return `${ascii}${port && port !== 25565 ? `:${port}` : ''}`;
  }
  return `${host}${port && port !== 25565 ? `:${port}` : ''}`;
}
