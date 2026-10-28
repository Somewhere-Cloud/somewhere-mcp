/**
 * Reader-facing section ids that replace a heading's slug, scoped by topic
 * (tsk_04eacc515a0f4a1e8bc6732380ec96d1). Keys are the canonical topic id and
 * the section's heading-slug id (with any duplicate suffix); values are the
 * short id the docs tool, the summary index and the manifest `sections[]` show.
 *
 * The old id stays a valid `section` request, and the heading text does not
 * change, so the /docs heading anchor (built from the heading text) is
 * unchanged. A rename that would collide with another section id in the same
 * topic, or whose old id no longer exists, is not applied and is reported by
 * docsSectionIdProblems() — generation fails on it.
 */
export const DOCS_SECTION_ID_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'sw.auth': Object.freeze({
    'password-reset-flow': 'password-reset',
    'magic-links-passwordless-sign-in': 'magic-links',
    'mfa-totp': 'mfa',
    'social-oauth': 'social-sign-in',
    'header-based-auto-refresh-manual-token-mode': 'token-refresh',
    'visitors-before-sign-in': 'visitors',
    'security-model-the-industry-standard-checklist': 'security',
  }),
});
