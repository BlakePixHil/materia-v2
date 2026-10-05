/**
 * A cheap English check for ingested text (AI-04 edge case: non-English text is embedded as is and
 * its language flagged). English prose is full of these function words; text with too few of them
 * is flagged `und` (not English, language unknown). OCR and classification report a real ISO 639-1
 * code, which wins over this guess.
 */
const ENGLISH = new Set(
  (
    'the and of to in is that for be by with as on this will my or are at from it an any all not shall which ' +
    'have has was were i you he she they we his her their our me him them if under such each been may'
  ).split(' '),
);

/** `en`, `und` (some other language), or null when there are too few words to tell. */
export function detectLanguage(text: string): 'en' | 'und' | null {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 40) return null;
  const english = words.filter((word) => ENGLISH.has(word)).length;
  return english / words.length >= 0.12 ? 'en' : 'und';
}
