/**
 * Gmail OAuth. Run once by hand, then every other module just calls {@link gmailClient}.
 *
 *   node src/gmail/auth.ts            authorise (opens a browser)
 *   node src/gmail/auth.ts --status    which account, which scopes, when the token expires
 *
 * This is the **loopback** flow, the only one Google still supports for a desktop app: a
 * throwaway HTTP server on a random localhost port receives the `?code=`, exchanges it, and
 * writes `token.json`. The old copy-paste-the-code flow (`urn:ietf:wg:oauth:2.0:oob`) was
 * switched off in 2022, so anything that looks simpler than this no longer works.
 *
 * `token.json` holds a refresh token that can read Utkarsh's whole mailbox and send mail as
 * him. It is gitignored and written `0600`. Never log it, never copy it anywhere.
 *
 * **The 7-day trap.** While the OAuth consent screen is in "Testing", Google expires the
 * refresh token after seven days — so a pipeline that worked all week starts failing with
 * `invalid_grant` on day eight. That is not a bug in this file; it is fixed by publishing
 * the consent screen, and until then by re-running this command. `describeAuthError` says so
 * out loud rather than letting a fresh session go hunting.
 */
import {
  auth as gmailAuth,
  gmail as gmailApi,
  type gmail_v1,
} from "@googleapis/gmail";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const CREDENTIALS_PATH =
  process.env["GOOGLE_CREDENTIALS_PATH"] ?? "credentials.json";
export const TOKEN_PATH = process.env["GOOGLE_TOKEN_PATH"] ?? "token.json";

/**
 * Read alert emails, write drafts, send them. Nothing wider.
 * `gmail.compose` covers drafts.create; `gmail.send` covers drafts.send (invariant 1 — the
 * pipeline only ever sends an existing draft). Adding a scope means Utkarsh re-consents, so
 * they are worth getting right once: no `gmail.modify`, no full `mail.google.com`.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

/** The shape Google's Desktop-app credentials download actually has. */
const Credentials = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  }),
});

/** What we persist. Google returns more than this; these are the fields that matter. */
const StoredToken = z.object({
  refresh_token: z.string().min(1),
  access_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  expiry_date: z.number().optional(),
});
export type StoredToken = z.infer<typeof StoredToken>;

export function readCredentials(
  path = CREDENTIALS_PATH,
): z.infer<typeof Credentials>["installed"] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `no readable Google credentials at ${path} — download a Desktop-app OAuth client from ` +
        `console.cloud.google.com → APIs & Services → Credentials, and save it there. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const parsed = Credentials.safeParse(raw);
  if (!parsed.success) {
    // The usual mistake: a Web-application client, whose JSON has `web` instead of
    // `installed`. It cannot do the loopback flow, so say so plainly.
    const key =
      typeof raw === "object" && raw !== null ? Object.keys(raw)[0] : undefined;
    throw new Error(
      `${path} is not a Desktop-app OAuth client` +
        (key !== undefined && key !== "installed"
          ? ` — its JSON has "${key}", expected "installed"`
          : "") +
        '. Create the credential as type "Desktop app" and download it again.',
    );
  }
  return parsed.data.installed;
}

export function hasToken(path = TOKEN_PATH): boolean {
  try {
    StoredToken.parse(JSON.parse(readFileSync(path, "utf8")));
    return true;
  } catch {
    return false;
  }
}

function readToken(path = TOKEN_PATH): StoredToken {
  try {
    return StoredToken.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    throw new Error(
      `no usable Gmail token at ${path} — run: node src/gmail/auth.ts ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** `0600`: this file is a password for the mailbox. */
function writeToken(token: StoredToken, path = TOKEN_PATH): void {
  writeFileSync(path, JSON.stringify(token, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Turn Google's opaque auth failures into the sentence that fixes them.
 *
 * `invalid_grant` has one overwhelmingly likely cause here and a completely different fix
 * from every other auth error, which is worth spelling out at the point of failure.
 */
export function describeAuthError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (/invalid_grant/i.test(message)) {
    return (
      "Gmail refused the refresh token (invalid_grant). Almost always this is the 7-day " +
      'expiry that applies while the OAuth consent screen is in "Testing" — publish the ' +
      "consent screen to stop it recurring. Either way, fix it now by re-running: " +
      "node src/gmail/auth.ts"
    );
  }
  if (/invalid_client/i.test(message)) {
    return `Google rejected the client in ${CREDENTIALS_PATH} (invalid_client) — the OAuth client may have been deleted or regenerated. Download it again.`;
  }
  if (
    /insufficient|insufficientPermissions|ACCESS_TOKEN_SCOPE/i.test(message)
  ) {
    return `The stored token is missing a scope this needs (${SCOPES.join(", ")}). Re-run: node src/gmail/auth.ts`;
  }
  return message;
}

/**
 * An authenticated Gmail client. Non-interactive — throws if nobody has authorised yet.
 *
 * Refreshed access tokens are written straight back to `token.json`, so a long-running
 * pipeline and tomorrow's run share one valid credential instead of each minting their own.
 */
export function gmailClient(): gmail_v1.Gmail {
  const { client_id, client_secret } = readCredentials();
  const token = readToken();

  const client = new gmailAuth.OAuth2({
    clientId: client_id,
    clientSecret: client_secret,
  });
  client.setCredentials(token);

  client.on("tokens", (fresh) => {
    // Google omits refresh_token on a refresh response; keep the one we already have.
    writeToken({
      ...token,
      ...Object.fromEntries(
        Object.entries(fresh).filter(([, v]) => v !== null && v !== undefined),
      ),
      refresh_token: fresh.refresh_token ?? token.refresh_token,
    } as StoredToken);
  });

  return gmailApi({ version: "v1", auth: client });
}

/** Best-effort browser open. The URL is always printed too, so this failing costs nothing. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* printed below anyway */
  }
}

const PAGE = (title: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>jobagent</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:32rem">` +
  `<h1 style="font-size:1.2rem">${title}</h1><p>${detail}</p></body>`;

/**
 * The interactive flow. Opens a browser, waits for the redirect, writes `token.json`.
 *
 * PKCE is used even though this client has a secret: a "secret" shipped in a desktop app is
 * not one, so the code exchange is bound to a verifier only this process knows. `state` is
 * checked for the same reason — the loopback port is open to anything on the machine.
 */
export async function authorize(): Promise<{ email: string | null }> {
  const { client_id, client_secret } = readCredentials();

  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // Port 0 = let the OS choose. Desktop clients may use any loopback port; that is why
    // credentials.json only lists `http://localhost` with no port.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string")
        return reject(new Error("no port"));
      resolve(addr.port);
    });
  });

  const redirectUri = `http://localhost:${port}`;
  const client = new gmailAuth.OAuth2({
    clientId: client_id,
    clientSecret: client_secret,
    redirectUri,
  });

  const { codeVerifier, codeChallenge } =
    await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString("hex");

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: [...SCOPES],
    // Without this, a second authorisation returns no refresh token at all and the pipeline
    // silently gets a credential that dies in an hour.
    prompt: "consent",
    state,
    code_challenge_method: "S256" as never,
    code_challenge: codeChallenge,
  });

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("nobody completed the consent screen within 5 minutes"));
    }, 300_000);

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/" && url.pathname !== "/favicon.ico")
        return res.end();
      if (url.pathname === "/favicon.ico") return res.end();

      const error = url.searchParams.get("error");
      const received = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");

      const fail = (why: string) => {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(PAGE("Authorisation failed", why));
        clearTimeout(timeout);
        server.close();
        reject(new Error(why));
      };

      if (error !== null) return fail(`Google returned "${error}".`);
      if (gotState !== state)
        return fail(
          "State mismatch — the redirect did not come from this run.",
        );
      if (received === null)
        return fail("The redirect carried no authorisation code.");

      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        PAGE(
          "jobagent is authorised ✅",
          "You can close this tab and go back to the terminal.",
        ),
      );
      clearTimeout(timeout);
      server.close();
      resolve(received);
    });

    console.log("Opening your browser to approve Gmail access…\n");
    console.log(
      `If it does not open, paste this into your browser:\n\n${authUrl}\n`,
    );
    console.log(
      "The consent screen will warn that the app is unverified — that is expected",
    );
    console.log(
      "for a personal tool in Testing mode. Choose your own account.\n",
    );
    openBrowser(authUrl);
  });

  const { tokens } = await client.getToken({ code, codeVerifier });

  if (!tokens.refresh_token) {
    throw new Error(
      "Google returned no refresh token, so the pipeline could not run unattended. Revoke " +
        "this app at myaccount.google.com/permissions and run this command again.",
    );
  }

  writeToken(StoredToken.parse(tokens));
  client.setCredentials(tokens);

  // Prove the credential works now, rather than at 06:00 tomorrow.
  const profile = await gmailApi({
    version: "v1",
    auth: client,
  }).users.getProfile({ userId: "me" });
  return { email: profile.data.emailAddress ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function status(): Promise<number> {
  if (!hasToken()) {
    console.log(`no token at ${TOKEN_PATH} — run: node src/gmail/auth.ts`);
    return 1;
  }

  const token = readToken();
  try {
    const profile = await gmailClient().users.getProfile({ userId: "me" });
    console.log(`account   ${profile.data.emailAddress}`);
    console.log(
      `messages  ${profile.data.messagesTotal?.toLocaleString() ?? "?"}`,
    );
    console.log(
      `scopes    ${token.scope?.split(" ").join("\n          ") ?? "(not recorded)"}`,
    );
    const missing = SCOPES.filter(
      (s) => token.scope !== undefined && !token.scope.includes(s),
    );
    if (missing.length > 0) {
      console.log(
        `\nMISSING   ${missing.join("\n          ")}\nRe-run: node src/gmail/auth.ts`,
      );
      return 1;
    }
    console.log("\nGmail is ready.");
    return 0;
  } catch (err) {
    console.error(describeAuthError(err));
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--status")) return status();

  if (hasToken() && !argv.includes("--force")) {
    console.log(`${TOKEN_PATH} already exists. Checking it…\n`);

    if ((await status()) === 0) {
      console.log("\nNothing to do. Re-authorise anyway with --force.");
      return 0;
    }

    // A token that exists but no longer works is *the* reason to run this command, so do
    // the thing rather than describing it. This used to return here, and because
    // `describeAuthError` ends with "re-run: node src/gmail/auth.ts", the command told you
    // to run the command you had just run — a loop with no way out except knowing about
    // `--force`. Reported 2026-08-23.
    console.log("\nThat token no longer works, so re-authorising now.\n");
  }

  try {
    const { email } = await authorize();
    console.log(
      `\nAuthorised as ${email ?? "that account"}. Wrote ${TOKEN_PATH} (mode 600).`,
    );
    console.log(
      "Note: in Testing mode this token expires after 7 days — see the header of this file.",
    );
    return 0;
  } catch (err) {
    console.error(`\n${describeAuthError(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
