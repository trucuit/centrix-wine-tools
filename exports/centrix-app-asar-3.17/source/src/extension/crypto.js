const te = new TextEncoder();
const td = new TextDecoder();

function bytesToB64(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomB64(len = 16) {
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return bytesToB64(arr);
}

export async function deriveKey(masterPassword, saltB64, extractable = false) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    te.encode(masterPassword),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b64ToBytes(saltB64),
      iterations: 250000,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

export async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = te.encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
  return {
    iv: bytesToB64(iv),
    cipher: bytesToB64(new Uint8Array(cipher))
  };
}

export async function decryptJson(key, encrypted) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(encrypted.iv) },
    key,
    b64ToBytes(encrypted.cipher)
  );
  return JSON.parse(td.decode(plain));
}
