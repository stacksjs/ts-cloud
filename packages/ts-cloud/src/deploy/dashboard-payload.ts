/**
 * Serialize the dashboard payload for the trip through an environment variable.
 *
 * The UI is rebuilt by spawning stx with the resolved data in
 * `TSCLOUD_DASHBOARD_DATA`. Environment variables are bytes, and the child
 * decodes them using its locale — so on a box whose locale is `POSIX`/`C`
 * (the default on most minimal server images) every non-ASCII character in the
 * payload comes back mis-decoded and is then re-encoded as UTF-8, arriving in
 * the built page as mojibake: `—` renders as `â€"`, `·` as `Â·`.
 *
 * That is not hypothetical or cosmetic. It corrupts any project name, domain,
 * or status text carrying an accent or a dash, on exactly the hosts operators
 * are most likely to provision.
 *
 * Escaping every non-ASCII code point makes the transport pure ASCII, which no
 * locale can misread. `JSON.parse` on the other side turns the escapes back
 * into the original characters, so the payload is unchanged — only its wire
 * form is narrowed.
 */
export function encodeDashboardPayload(data: unknown): string {
  // JSON.stringify already escapes everything below 0x20, so only the high end
  // needs narrowing. Escaping per UTF-16 code unit keeps surrogate pairs valid:
  // each half ships as its own escape and JSON.parse rejoins them.
  const nonAscii = new RegExp('[\\u007F-\\uFFFF]', 'g')
  return JSON.stringify(data).replace(
    nonAscii,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
