/**
 * Job descriptions arrive as HTML from most boards. We only ever feed them to an
 * embedding model and to Haiku, so we want readable plain text — not a DOM. This is a
 * deliberately small regex stripper, not a parser.
 *
 * Greenhouse is the awkward one: its `content` field is *entity-escaped* HTML, so the
 * raw string contains `&lt;p&gt;` rather than `<p>`. Decoding has to happen before
 * stripping, and again afterwards for entities inside the text itself.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  middot: '·',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * HTML (or entity-escaped HTML) → plain text with paragraph breaks preserved.
 * Block-level tags become newlines so bullet lists survive as lines.
 */
export function htmlToText(input: string): string {
  if (!input) return '';

  // Greenhouse hands us escaped markup; decoding first turns it into real tags.
  let text = /&lt;\/?[a-z]/i.test(input) ? decodeEntities(input) : input;

  text = text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|section)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(text)
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
