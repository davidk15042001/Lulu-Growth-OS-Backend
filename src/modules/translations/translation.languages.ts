export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'German' },
  { code: 'zh-CN', name: 'Simplified Chinese' },
  { code: 'fr', name: 'French' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'nb', name: 'Norwegian Bokmal' },
  { code: 'sv', name: 'Swedish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'da', name: 'Danish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'lb', name: 'Luxembourgish' },
  { code: 'mn', name: 'Mongolian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ru', name: 'Russian' },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((language) => language.code) as [
  SupportedLanguageCode,
  ...SupportedLanguageCode[],
];

export function getSupportedLanguage(code: SupportedLanguageCode) {
  return SUPPORTED_LANGUAGES.find((language) => language.code === code)!;
}
