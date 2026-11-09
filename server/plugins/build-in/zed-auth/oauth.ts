import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  OAuth2AuthorizationCodeAddMethod,
  OAuth2AuthorizationCodeBegin,
  ResourceDraft,
} from "cursor-byok:resource";
import { credentialDraft, syncAccountProfile } from "./resources.ts";

const ZED_SIGNIN_URL = "https://zed.dev/native_app_signin";
const AUTHORIZATION_LIFETIME_MS = 5 * 60 * 1000;

// ASN.1 AlgorithmIdentifier for rsaEncryption (1.2.840.113549.1.1.1) with NULL parameters
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30,
  0x0d,
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01,
  0x05,
  0x00,
]);

type Session = {
  createdAtMs: number;
  privateKeyJwk: JsonWebKey;
  systemId: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Matches Rust `base64::prelude::BASE64_URL_SAFE` (URL-safe alphabet with `=` padding). */
export function encodeBase64UrlSafe(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

export function decodeBase64UrlSafe(encoded: string): Uint8Array {
  const normalized = encoded.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function readDerLength(bytes: Uint8Array, offset: number): { length: number; nextOffset: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error("unexpected end of DER buffer");
  if ((first & 0x80) === 0) {
    return { length: first, nextOffset: offset + 1 };
  }
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    const b = bytes[offset + 1 + i];
    if (b === undefined) throw new Error("truncated DER length");
    length = (length << 8) | b;
  }
  return { length, nextOffset: offset + 1 + numBytes };
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/**
 * Extracts PKCS#1 `RSAPublicKey` DER bytes from an X.509 `SubjectPublicKeyInfo` (SPKI) DER buffer.
 * Zed's `rpc::auth::PublicKey` expects PKCS#1 DER encoded with `BASE64_URL_SAFE`.
 */
export function spkiToPkcs1Der(spki: Uint8Array): Uint8Array {
  if (spki[0] !== 0x30) throw new Error("SPKI must start with a SEQUENCE tag");
  const outer = readDerLength(spki, 1);
  let offset = outer.nextOffset;
  if (spki[offset] !== 0x30) throw new Error("SPKI missing AlgorithmIdentifier SEQUENCE");
  const alg = readDerLength(spki, offset + 1);
  offset = alg.nextOffset + alg.length;
  if (spki[offset] !== 0x03) throw new Error("SPKI missing BIT STRING tag");
  const bitString = readDerLength(spki, offset + 1);
  const unusedBits = spki[bitString.nextOffset];
  if (unusedBits !== 0x00) throw new Error("SPKI BIT STRING has non-zero unused bits");
  const pkcs1Start = bitString.nextOffset + 1;
  return spki.slice(pkcs1Start, pkcs1Start + bitString.length - 1);
}

/** Wraps PKCS#1 `RSAPublicKey` DER bytes into an X.509 SPKI DER buffer for WebCrypto import. */
export function pkcs1ToSpkiDer(pkcs1: Uint8Array): Uint8Array {
  const bitStringPayloadLen = pkcs1.length + 1;
  const bitStringLenBytes = encodeDerLength(bitStringPayloadLen);
  const bitString = new Uint8Array(1 + bitStringLenBytes.length + 1 + pkcs1.length);
  bitString[0] = 0x03;
  bitString.set(bitStringLenBytes, 1);
  bitString[1 + bitStringLenBytes.length] = 0x00;
  bitString.set(pkcs1, 1 + bitStringLenBytes.length + 1);

  const outerPayloadLen = RSA_ALGORITHM_IDENTIFIER.length + bitString.length;
  const outerLenBytes = encodeDerLength(outerPayloadLen);
  const spki = new Uint8Array(1 + outerLenBytes.length + outerPayloadLen);
  spki[0] = 0x30;
  spki.set(outerLenBytes, 1);
  spki.set(RSA_ALGORITHM_IDENTIFIER, 1 + outerLenBytes.length);
  spki.set(bitString, 1 + outerLenBytes.length + RSA_ALGORITHM_IDENTIFIER.length);
  return spki;
}

export async function generateZedKeypair(): Promise<{
  publicKeyBase64Url: string;
  privateKeyJwk: JsonWebKey;
}> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const spkiBuffer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  const pkcs1Der = spkiToPkcs1Der(new Uint8Array(spkiBuffer));
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    publicKeyBase64Url: encodeBase64UrlSafe(pkcs1Der),
    privateKeyJwk,
  };
}

export async function decryptZedAccessToken(
  privateKeyJwk: JsonWebKey,
  encryptedBase64Url: string,
): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const ciphertext = decodeBase64UrlSafe(encryptedBase64Url);
  const decrypted = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer,
  );
  return new TextDecoder().decode(decrypted);
}

function parseSession(value: JsonValue): Session {
  const session = object(value);
  const createdAtMs = session?.createdAtMs;
  const privateKeyJwk = object(session?.privateKeyJwk) as JsonWebKey | null;
  const systemId = text(session?.systemId);
  if (typeof createdAtMs !== "number" || !privateKeyJwk || !systemId) {
    throw new Error("Zed OAuth session is invalid");
  }
  if (Date.now() - createdAtMs > AUTHORIZATION_LIFETIME_MS) {
    throw new Error("Zed authorization expired. Please try again.");
  }
  return { createdAtMs, privateKeyJwk, systemId };
}

function parseCallbackCode(code: string): { userId: string; encryptedAccessToken: string } {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = object(JSON.parse(code));
  } catch {
    throw new Error("Zed callback payload is not valid JSON");
  }
  const userId = text(parsed?.user_id);
  const encryptedAccessToken = text(parsed?.access_token);
  if (!userId || !encryptedAccessToken) {
    throw new Error("Zed callback is missing user_id or access_token");
  }
  return { userId, encryptedAccessToken };
}

async function begin(
  input: { redirectUri: string; state: string; codeChallenge: string },
  _context: PluginContext,
): Promise<OAuth2AuthorizationCodeBegin> {
  const redirectUrl = new URL(input.redirectUri);
  const port = redirectUrl.port;
  if (!port) {
    throw new Error(`Zed OAuth redirect URI is missing a loopback port: ${input.redirectUri}`);
  }
  const { publicKeyBase64Url, privateKeyJwk } = await generateZedKeypair();
  const systemId = crypto.randomUUID();
  const params = new URLSearchParams({
    native_app_port: port,
    native_app_public_key: publicKeyBase64Url,
    system_id: systemId,
  });
  return {
    session: {
      createdAtMs: Date.now(),
      privateKeyJwk: privateKeyJwk as unknown as JsonValue,
      systemId,
    },
    authorizationUrl: `${ZED_SIGNIN_URL}?${params.toString()}`,
    expiresAtMs: Date.now() + AUTHORIZATION_LIFETIME_MS,
  };
}

async function complete(
  sessionValue: JsonValue,
  input: { code: string; redirectUri: string; codeVerifier: string },
  context: PluginContext,
): Promise<ResourceDraft[]> {
  const session = parseSession(sessionValue);
  const { userId, encryptedAccessToken } = parseCallbackCode(input.code);
  const accessToken = await decryptZedAccessToken(session.privateKeyJwk, encryptedAccessToken);

  const candidate = await syncAccountProfile(
    {
      userId,
      accessToken,
      systemId: session.systemId,
    },
    context.network,
  );
  return [await credentialDraft(candidate)];
}

export const zedNativeAppOAuth: OAuth2AuthorizationCodeAddMethod = {
  type: "oauth2.authorization-code",
  id: "zed-native-signin",
  displayName: {
    "en-US": "Sign in with Zed (GitHub / Student / Pro)",
    "zh-CN": "使用 Zed 账号登录（GitHub / 学生认证 / Pro）",
  },
  description: {
    "en-US": "Authorize in your browser via zed.dev to use Zed Pro or Student ($10/mo) credits.",
    "zh-CN": "在浏览器中通过 zed.dev 授权，使用 Zed Pro 或学生认证（$10/月）托管模型额度。",
  },
  callback: { path: "/" },
  begin,
  complete,
};
