/**
 * Candidate companies to probe for a public job board.
 *
 * This is a wish list, not the seed list. Nothing here is trusted: every entry gets its
 * slug guessed and then checked against the live ATS APIs by `refresh-companies.ts`, and
 * only the ones that actually answer end up in `data/companies.json`. Roughly half of
 * any hand-written slug list is wrong, so guessing-then-verifying beats guessing.
 *
 * Geography follows the 2026-08-09 decision: Indian companies, plus remote-first
 * companies that hire globally. US/Europe-onsite-only companies are deliberately absent.
 *
 * To add companies: append here, then re-run `node src/ingest/refresh-companies.ts`.
 */
import type { Region } from './companies.ts';

export type Candidate = {
  name: string;
  domain: string;
  /** Matches `SeedCompany.regions`, which zod validates as non-empty at load time. */
  regions: Region[];
  /** Known-good slugs, when the guesser would not find them. */
  slugs?: string[];
};

/** Declare a candidate company that hires in India. */
const india = (name: string, domain: string, slugs?: string[]): Candidate => ({
  name,
  domain,
  regions: ['india'],
  ...(slugs ? { slugs } : {}),
});

/** Declare a candidate company that hires remotely worldwide. */
const remote = (name: string, domain: string, slugs?: string[]): Candidate => ({
  name,
  domain,
  regions: ['remote-global'],
  ...(slugs ? { slugs } : {}),
});

export const CANDIDATES: Candidate[] = [
  // ── Indian consumer / marketplace ──────────────────────────────────────────
  india('Zomato', 'zomato.com'),
  india('Swiggy', 'swiggy.com'),
  india('Flipkart', 'flipkart.com'),
  india('Meesho', 'meesho.com'),
  india('Myntra', 'myntra.com'),
  india('Nykaa', 'nykaa.com'),
  india('Lenskart', 'lenskart.com'),
  india('Zepto', 'zeptonow.com'),
  india('Blinkit', 'blinkit.com'),
  india('Licious', 'licious.in'),
  india('Urban Company', 'urbancompany.com'),
  india('Rapido', 'rapido.bike'),
  india('Ola', 'olacabs.com'),
  india('Ola Electric', 'olaelectric.com'),
  india('Dream11', 'dream11.com'),
  india('Games24x7', 'games24x7.com'),
  india('MPL', 'mpl.live'),
  india('ShareChat', 'sharechat.com'),
  india('Dailyhunt', 'dailyhunt.in'),
  india('Zetwerk', 'zetwerk.com'),
  india('Udaan', 'udaan.com'),
  india('Delhivery', 'delhivery.com'),
  india('Shiprocket', 'shiprocket.in'),
  india('Bizongo', 'bizongo.com'),
  india('Moglix', 'moglix.com'),
  india('Ninjacart', 'ninjacart.in'),
  india('DeHaat', 'agrevolution.in'),
  india('Cropin', 'cropin.com'),

  // ── Indian fintech ─────────────────────────────────────────────────────────
  india('Razorpay', 'razorpay.com'),
  india('CRED', 'cred.club'),
  india('PhonePe', 'phonepe.com'),
  india('Paytm', 'paytm.com'),
  india('Zerodha', 'zerodha.com'),
  india('Groww', 'groww.in'),
  india('Upstox', 'upstox.com'),
  india('Jupiter', 'jupiter.money'),
  india('Fi Money', 'fi.money'),
  india('Slice', 'sliceit.com'),
  india('Navi', 'navi.com'),
  india('KreditBee', 'kreditbee.in'),
  india('Money View', 'moneyview.in'),
  india('Cashfree Payments', 'cashfree.com'),
  india('Juspay', 'juspay.in'),
  india('Pine Labs', 'pinelabs.com'),
  india('BharatPe', 'bharatpe.com'),
  india('Setu', 'setu.co'),
  india('Decentro', 'decentro.tech'),
  india('Acko', 'acko.com'),
  india('Digit Insurance', 'godigit.com'),
  india('Policybazaar', 'policybazaar.com'),
  india('Turtlemint', 'turtlemint.com'),
  india('M2P Fintech', 'm2pfintech.com'),
  india('Perfios', 'perfios.com'),
  india('Signzy', 'signzy.com'),

  // ── Indian SaaS / devtools ─────────────────────────────────────────────────
  india('Postman', 'postman.com'),
  india('BrowserStack', 'browserstack.com'),
  india('Freshworks', 'freshworks.com'),
  india('Zoho', 'zoho.com'),
  india('Chargebee', 'chargebee.com'),
  india('Hasura', 'hasura.io'),
  india('Atlan', 'atlan.com'),
  india('CleverTap', 'clevertap.com'),
  india('MoEngage', 'moengage.com'),
  india('WebEngage', 'webengage.com'),
  india('Netcore Cloud', 'netcorecloud.com'),
  india('Exotel', 'exotel.com'),
  india('Gupshup', 'gupshup.io'),
  india('Yellow.ai', 'yellow.ai'),
  india('Haptik', 'haptik.ai'),
  india('Uniphore', 'uniphore.com'),
  india('Observe.AI', 'observe.ai'),
  india('Whatfix', 'whatfix.com'),
  india('Innovaccer', 'innovaccer.com'),
  india('Darwinbox', 'darwinbox.com'),
  india('Keka', 'keka.com'),
  india('Wingify', 'wingify.com'),
  india('Zluri', 'zluri.com'),
  india('LeadSquared', 'leadsquared.com'),
  india('Locus', 'locus.sh'),
  india('FarEye', 'fareye.com'),
  india('LogiNext', 'loginextsolutions.com'),
  india('Sprinklr', 'sprinklr.com'),
  india('Icertis', 'icertis.com'),
  india('Druva', 'druva.com'),
  india('Rubrik', 'rubrik.com'),
  india('Nutanix', 'nutanix.com'),

  // ── Indian AI / data ───────────────────────────────────────────────────────
  india('Fractal Analytics', 'fractal.ai'),
  india('Mu Sigma', 'mu-sigma.com'),
  india('Tiger Analytics', 'tigeranalytics.com'),
  india('LatentView Analytics', 'latentview.com'),
  india('Quantiphi', 'quantiphi.com'),
  india('Sigmoid', 'sigmoid.com'),
  india('Mad Street Den', 'madstreetden.com'),
  india('Krutrim', 'olakrutrim.com'),
  india('Sarvam AI', 'sarvam.ai'),

  // ── Indian edtech ──────────────────────────────────────────────────────────
  india('Unacademy', 'unacademy.com'),
  india('PhysicsWallah', 'pw.live'),
  india('Vedantu', 'vedantu.com'),
  india('Scaler', 'scaler.com'),
  india('Newton School', 'newtonschool.co'),
  india('upGrad', 'upgrad.com'),
  india('Emeritus', 'emeritus.org'),
  india('HackerRank', 'hackerrank.com'),
  india('HackerEarth', 'hackerearth.com'),

  // ── Remote-first, hires globally ───────────────────────────────────────────
  remote('GitLab', 'gitlab.com'),
  remote('Automattic', 'automattic.com'),
  remote('Zapier', 'zapier.com'),
  remote('Doist', 'doist.com'),
  remote('Buffer', 'buffer.com'),
  remote('Toggl', 'toggl.com'),
  remote('Hotjar', 'hotjar.com'),
  remote('Remote', 'remote.com'),
  remote('Deel', 'deel.com'),
  remote('Oyster', 'oysterhr.com'),
  remote('Turing', 'turing.com'),
  remote('Canonical', 'canonical.com'),
  remote('Elastic', 'elastic.co'),
  remote('HashiCorp', 'hashicorp.com'),
  remote('Grafana Labs', 'grafana.com'),
  remote('Sourcegraph', 'sourcegraph.com'),
  remote('Supabase', 'supabase.com'),
  remote('Vercel', 'vercel.com'),
  remote('Netlify', 'netlify.com'),
  remote('Render', 'render.com'),
  remote('Railway', 'railway.app'),
  remote('Cloudflare', 'cloudflare.com'),
  remote('DigitalOcean', 'digitalocean.com'),
  remote('MongoDB', 'mongodb.com'),
  remote('Redis', 'redis.com'),
  remote('Confluent', 'confluent.io'),
  remote('Airbyte', 'airbyte.com'),
  remote('dbt Labs', 'getdbt.com'),
  remote('Dagster Labs', 'dagsterlabs.com'),
  remote('Weights & Biases', 'wandb.com'),
  remote('Hugging Face', 'huggingface.co'),
  remote('Replicate', 'replicate.com'),
  remote('Modal', 'modal.com'),
  remote('Together AI', 'together.ai'),
  remote('Anyscale', 'anyscale.com'),
  remote('LangChain', 'langchain.com'),
  remote('Pinecone', 'pinecone.io'),
  remote('Weaviate', 'weaviate.io'),
  remote('Qdrant', 'qdrant.tech'),
  remote('Scale AI', 'scale.com'),
  remote('Labelbox', 'labelbox.com'),
  remote('Linear', 'linear.app'),
  remote('Notion', 'notion.so'),
  remote('Figma', 'figma.com'),
  remote('Retool', 'retool.com'),
  remote('Ramp', 'ramp.com'),
  remote('Stripe', 'stripe.com'),
  remote('Twilio', 'twilio.com'),
  remote('Anthropic', 'anthropic.com'),
];
