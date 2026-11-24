const enc = new TextEncoder();

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Token = "<userId>.<HMAC(userId)>". Anonymous users are "a_<deviceId>"; sign-in later maps accounts to ids. */
export async function signToken(userId: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(userId));
  return `${userId}.${b64url(sig)}`;
}

export async function verifyToken(token: string | undefined, secret: string): Promise<string | null> {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const userId = token.slice(0, i);
  const expected = await signToken(userId, secret);
  if (expected.length !== token.length) return null;
  let diff = 0;
  for (let k = 0; k < token.length; k++) diff |= token.charCodeAt(k) ^ expected.charCodeAt(k);
  return diff === 0 ? userId : null;
}
