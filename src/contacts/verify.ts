/**
 * Can this domain receive mail at all?
 *
 * One DNS question, asked twice for two different reasons:
 *
 * - **Before believing a domain.** A company whose domain resolves but publishes no MX
 *   records is either the wrong domain or a site that does not take mail. Either way it is
 *   not the place we write to.
 * - **Before storing an address.** Decision 006 chose source provenance over a paid verifier
 *   API, and this is the free gate that complements it: provenance says whether the address
 *   is *plausible*, MX says whether the domain could deliver it at all. A bounce is what
 *   actually damages sender reputation, so a structural check before the address is ever
 *   stored is worth its five milliseconds.
 *
 * What this does **not** do is prove the mailbox exists. Nothing free does. `hr@acme.com`
 * with valid MX is still a guess — which is exactly why a pattern-sourced contact is
 * `confidence: 'low'` and can never auto-send (invariant 3).
 */
import { promises as dns } from 'node:dns';
import { normaliseDomain } from '../store/companies.ts';

/**
 * c-ares has its own retry schedule and will sit there for tens of seconds against a
 * resolver that is answering slowly rather than not at all. The contacts stage asks about
 * several candidate domains per company, so a slow answer has to cost a bounded amount.
 */
const DNS_TIMEOUT_MS = 5_000;

/** One process, one answer per domain. The cascade asks about the same domain repeatedly. */
const cache = new Map<string, boolean>();

/** Exposed for tests, which must not inherit another test's answers. */
export const clearMxCache = (): void => cache.clear();

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`dns timed out after ${ms}ms`)), ms).unref();
    }),
  ]);

/**
 * Does `domain` publish MX records?
 *
 * Never throws. A DNS failure of any kind is reported as "no", because every caller is
 * asking the same practical question — is it safe to treat this as a mail destination —
 * and the honest answer when DNS will not say is no.
 */
export async function hasMx(domain: string): Promise<boolean> {
  const host = normaliseDomain(domain);
  const cached = cache.get(host);
  if (cached !== undefined) return cached;

  let ok = false;
  try {
    const records = await withTimeout(dns.resolveMx(host), DNS_TIMEOUT_MS);
    // A single MX whose exchange is empty or `.` is the RFC 7505 "null MX": the domain has
    // explicitly announced that it accepts no mail. Reading that as valid would be exactly
    // backwards.
    ok = records.some((r) => r.exchange !== '' && r.exchange !== '.');
  } catch {
    ok = false;
  }

  cache.set(host, ok);
  return ok;
}

/** `hire@acme.com` → `acme.com`. Null when the address has no single `@`. */
export function domainOfEmail(email: string): string | null {
  const parts = email.trim().toLowerCase().split('@');
  return parts.length === 2 && parts[1] !== '' ? normaliseDomain(parts[1]!) : null;
}

/** Whether the address's domain can receive mail. An unparseable address is `false`. */
export async function mxValid(email: string): Promise<boolean> {
  const domain = domainOfEmail(email);
  return domain === null ? false : hasMx(domain);
}
