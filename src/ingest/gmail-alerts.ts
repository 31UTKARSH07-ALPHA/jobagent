/**
 * Job-alert emails as a `JobSource`.
 *
 * This is where Indian coverage comes from. 102 of 153 target companies — Zomato, Swiggy,
 * Flipkart, Zerodha, Razorpay, Freshworks — have no board on any supported ATS, so the pollers
 * cannot see them at all (decision 010). What they do have is a Naukri listing, and Naukri
 * mails Utkarsh about it.
 *
 * We read *his own mail*. Nothing here touches LinkedIn or Naukri directly — that is
 * decision 004, and it is the difference between a tool and a banned account.
 *
 * A sender with no parser is counted and reported rather than ignored, so the morning a
 * LinkedIn alert finally arrives it shows up as a number instead of as silence.
 */
import type { gmail_v1 } from '@googleapis/gmail';
import type { Db } from '../store/db.ts';
import type { AlertPosting, JobSource, RawJob, SourceContext } from './types.ts';
import type { Email } from '../gmail/messages.ts';
import { searchEmails } from '../gmail/messages.ts';
import { isEarlyCareerTechRole, matchesGeography } from './filter.ts';
import { resolveCompany } from './resolve-company.ts';
import { NAUKRI_SENDERS, parseNaukriEmail, toRawJob } from './naukri-alert.ts';
import { LINKEDIN_SENDERS, parseLinkedInEmail } from './linkedin-alert.ts';

/**
 * One entry per alert format we can actually read.
 *
 * Both were written against real mail rather than guessed at — Naukri on 2026-08-11, LinkedIn
 * on 2026-08-16, once 26 real digests had accumulated to write it against (decision 020).
 */
type AlertParser = {
  name: string;
  senders: RegExp;
  parse: (email: Email) => AlertPosting[];
};

const PARSERS: AlertParser[] = [
  { name: 'naukri', senders: NAUKRI_SENDERS, parse: parseNaukriEmail },
  { name: 'linkedin', senders: LINKEDIN_SENDERS, parse: parseLinkedInEmail },
];

/**
 * Senders worth fetching. Kept wider than `PARSERS` on purpose — LinkedIn mail is fetched and
 * counted as unparsed, which is the signal that it is time to write that parser.
 */
export const ALERT_QUERY = 'from:naukri.com OR from:linkedin.com';

/** How many alert emails to read in one run. Bulk mail is a few a day; this is just a fuse. */
const DEFAULT_LIMIT = 60;

export type GmailAlertOptions = {
  db: Db;
  /** Injected in tests; production builds one from `token.json`. */
  gmail?: gmail_v1.Gmail;
  limit?: number;
  query?: string;
};

export function gmailAlertSource(opts: GmailAlertOptions): JobSource {
  return {
    name: 'gmail-alert',

    async *fetch(since: Date, ctx: SourceContext = {}): AsyncIterable<RawJob> {
      const count = ctx.count ?? (() => {});

      let gmail = opts.gmail;
      if (gmail === undefined) {
        const { gmailClient, describeAuthError } = await import('../gmail/auth.ts');
        try {
          gmail = gmailClient();
        } catch (err) {
          // Surfaced as the sentence that fixes it, not as a raw Google error. The other
          // sources keep running; `runIngest` isolates each one.
          throw new Error(describeAuthError(err));
        }
      }

      for await (const email of searchEmails(gmail, {
        query: opts.query ?? ALERT_QUERY,
        since,
        limit: opts.limit ?? DEFAULT_LIMIT,
        onError: (m) => ctx.onError?.(m),
      })) {
        const parser = PARSERS.find((p) => p.senders.test(email.fromAddress));
        if (parser === undefined) {
          count('alert_unparsed');
          ctx.onError?.(`no parser for ${email.fromAddress} — "${email.subject.slice(0, 60)}"`);
          continue;
        }

        count(`alert_${parser.name}`);

        let postings;
        try {
          postings = parser.parse(email);
        } catch (err) {
          // A changed template costs one email, not the mailbox.
          count('alert_parse_failed');
          ctx.onError?.(
            `${parser.name} failed on "${email.subject.slice(0, 60)}": ` +
              (err instanceof Error ? err.message : String(err)),
          );
          continue;
        }

        // Marketing mail from the same sender parses to nothing. Normal, not an error, but
        // worth counting: all-zero for days means a template changed.
        if (postings.length === 0) count('alert_no_postings');

        for (const posting of postings) {
          count('seen');

          if (!isEarlyCareerTechRole(posting.title)) {
            count('dropped_title');
            continue;
          }
          if (!matchesGeography(`${posting.title} ${posting.location}`)) {
            count('dropped_geography');
            continue;
          }

          const company = resolveCompany(opts.db, posting.company);
          if (company.via === 'unknown') count('company_unresolved');

          const raw = toRawJob(posting, company, email.receivedAt);
          if (raw === null) {
            count('dropped_malformed');
            ctx.onError?.(`${parser.name}: unusable posting "${posting.title.slice(0, 50)}"`);
            continue;
          }

          yield raw;
        }
      }
    },
  };
}
