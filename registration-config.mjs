import fs from 'node:fs';
import { parseEnv } from 'node:util';
export function requireAgentAuthor(author) {
 if (typeof author !== 'string' || !author.trim()) throw Error('AGENT_AUTHOR must contain your author name');
 return author.trim();
}
export function registrationUrl(port = '21950') {
 // AGENT_PUBLIC_URL lets buyers reach the Standard API through a public tunnel/deployment.
 // When unset, the agent registers its loopback address (owner-only / local testing).
 const publicUrl = process.env.AGENT_PUBLIC_URL?.trim();
 if (publicUrl) {
  if (!/^https?:\/\/[^\s]+$/.test(publicUrl)) throw Error('AGENT_PUBLIC_URL must be a full http(s) URL');
  return publicUrl.replace(/\/+$/, '');
 }
 if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw Error('AGENT_API_PORT must be an integer between 1 and 65535');
 return `http://127.0.0.1:${Number(port)}`;
}
export function requireSavedRuntimeToken(path) {
 let token;
 try { token = parseEnv(fs.readFileSync(path, 'utf8')).MPS_RUNTIME_TOKEN; } catch { throw Error('Runtime key recovery required: private token file is missing or unreadable'); }
 if (!token || token.startsWith('*****')) throw Error('Runtime key recovery required: private token is missing or masked');
 return token;
}
