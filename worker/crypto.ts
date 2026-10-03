import type { Env } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) output[i] = binary.charCodeAt(i);
  return output;
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function aesKey(env: Env): Promise<CryptoKey> {
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 24) throw new Error('Encryption key is not configured or is too short.');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.ENCRYPTION_KEY));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), encoder.encode(plaintext));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(env: Env, ciphertext: string | null | undefined): Promise<string | null> {
  if (!ciphertext) return null;
  const [version, iv, encrypted] = ciphertext.split('.');
  if (version !== 'v1' || !iv || !encrypted) throw new Error('Stored secret has an unsupported format.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufferSource(fromBase64Url(iv)) }, await aesKey(env), bufferSource(fromBase64Url(encrypted)));
  return decoder.decode(plain);
}

export async function signSession(env: Env, payload: Record<string, unknown>): Promise<string> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 24) throw new Error('Session signing secret is not configured or is too short.');
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySession(env: Env, token: string): Promise<Record<string, unknown> | null> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 24) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, bufferSource(fromBase64Url(signature)), encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(fromBase64Url(body))) as Record<string, unknown>;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

export function cookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

export async function constantTimeTextEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let mismatch = 0;
  for (let i = 0; i < x.length; i++) mismatch |= x[i] ^ y[i];
  return mismatch === 0;
}

export function randomId(): string {
  return crypto.randomUUID();
}
