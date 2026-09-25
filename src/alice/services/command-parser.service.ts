import { Injectable } from '@nestjs/common';

export type ServiceCommand =
  | 'new_conversation'
  | 'model_fast'
  | 'model_smart'
  | 'which_model'
  | 'provider_openai'
  | 'provider_claude'
  | 'which_provider'
  | 'pending_followup'
  | 'help';

interface CommandDefinition {
  command: ServiceCommand;
  phrases: string[];
  /**
   * Requires an exact match instead of tolerating one recognition slip.
   *
   * Used where a false positive costs something: switching provider archives
   * the conversation, and "теперь код" is one character away from "теперь
   * клод". The lost tolerance is paid back by listing the spellings instead.
   */
  exact?: boolean;
}

/**
 * Latin spellings Yandex recognition returns for these brands, mapped to the
 * Cyrillic ones the phrase lists use.
 *
 * Seen in production: `переключись на open ai` and `переключись на чат gpt` —
 * Latin, and mixed with Cyrillic in the same phrase. Enumerating every mix in
 * the lists is hopeless, so the spelling is folded here instead and the lists
 * stay Cyrillic-only. ("Клод" worked from the start precisely because Yandex
 * has no Latin form for it.)
 */
const LATIN_BRANDS: [RegExp, string][] = [
  // Two-word forms first: "chat gpt" must not be rewritten as "chat гпт".
  [/\bchat\s+gpt\b/g, 'чат гпт'],
  [/\bopen\s+ai\b/g, 'опен ай'],
  [/\bchatgpt\b/g, 'чатгпт'],
  [/\bopenai\b/g, 'опенай'],
  [/\bgpt\b/g, 'гпт'],
  [/\bclaude\b/g, 'клод'],
];

const CLAUDE_NAMES = ['клода', 'клод', 'клауда', 'клауд', 'клоуд'];

const OPENAI_NAMES = [
  'чатгпт',
  'чат гпт',
  'чатгипити',
  'чат джипити',
  'чат джи пи ти',
  'джипити',
  'джи пи ти',
  'гпт',
  'опенай',
  'опен ай',
  'опен аи',
  'опен эй ай',
];

const SWITCH_PREFIXES = [
  'переключись на',
  'переключи на',
  'переключись обратно на',
  'давай',
  'включи',
  'верни',
  'хочу',
  'спроси у',
  'теперь',
];

const switchPhrases = (names: string[]): string[] => [
  ...names,
  ...SWITCH_PREFIXES.flatMap((prefix) => names.map((name) => `${prefix} ${name}`)),
];

/** Ways of addressing the skill by name: "спроси у X …", "скажи X …", "X, …". */
const ADDRESS_LEAD_INS = [
  ['спроси', 'у'],
  ['спроси'],
  ['спросить', 'у'],
  ['узнай', 'у'],
  ['попроси'],
  ['скажи'],
  ['передай'],
  [],
];

const COMMANDS: CommandDefinition[] = [
  {
    command: 'new_conversation',
    phrases: [
      'новый разговор',
      'начни новый разговор',
      'начать новый разговор',
      'давай новый разговор',
      'забудь текущий разговор',
      'забудь разговор',
      'начни сначала',
      'новая тема',
    ],
  },
  {
    command: 'model_fast',
    phrases: ['быстрая модель', 'используй быструю модель', 'включи быструю модель'],
  },
  {
    command: 'model_smart',
    phrases: ['умная модель', 'используй умную модель', 'включи умную модель'],
  },
  {
    command: 'which_model',
    phrases: [
      'какая модель',
      'какая сейчас модель',
      'какая модель используется',
      'какую модель ты используешь',
      'какая используется модель',
    ],
  },
  {
    command: 'provider_claude',
    phrases: switchPhrases(CLAUDE_NAMES),
    exact: true,
  },
  {
    command: 'provider_openai',
    phrases: switchPhrases(OPENAI_NAMES),
    exact: true,
  },
  {
    command: 'which_provider',
    phrases: [
      'какой помощник',
      'кто отвечает',
      'какой провайдер',
      'кто сейчас отвечает',
      'какая нейросеть',
    ],
  },
  {
    command: 'pending_followup',
    phrases: [
      'ну что',
      'готово',
      'что там',
      'есть ответ',
      'ответ готов',
      'договорил',
      'что получилось',
      'ну как',
      'ты закончил',
      'ты готов',
    ],
  },
  { command: 'help', phrases: ['помощь', 'что ты умеешь', 'помоги'] },
];

/**
 * Recognises short service phrases.
 *
 * The rule is intentionally strict: a phrase counts as a command only when the
 * whole utterance matches (allowing one typo/ASR slip). Substring matching would
 * turn "Расскажи, что там происходило в Сталкере" into a pending follow-up.
 */
@Injectable()
export class CommandParserService {
  normalize(input: string): string {
    const text = input
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[.,!?;:"'«»()\-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return LATIN_BRANDS.reduce((result, [pattern, cyrillic]) => {
      pattern.lastIndex = 0;
      return result.replace(pattern, cyrillic);
    }, text);
  }

  /**
   * Removes the user's own name for the skill from the front of an utterance.
   *
   * Yandex strips the activation phrase only when launching the skill. Inside
   * an open session "спроси у дяди робота, что приготовить" arrives whole, and
   * the model answers that it does not know any "uncle robot" — it has no idea
   * the name refers to itself.
   *
   * Words are compared with one edit of slack each, so a single configured
   * "дядя робот" also covers "дяди робота" and "дяде роботу" without the user
   * having to list every Russian case.
   *
   * Returns the utterance unchanged when it is not an address, and an empty
   * string when it was *only* an address ("спроси у дяди робота").
   */
  stripAddress(input: string, names: string[]): string {
    if (names.length === 0) {
      return input;
    }

    const words = this.normalize(input).split(' ').filter(Boolean);

    for (const name of names) {
      const nameWords = this.normalize(name).split(' ').filter(Boolean);
      if (nameWords.length === 0) {
        continue;
      }

      for (const leadIn of ADDRESS_LEAD_INS) {
        const prefix = [...leadIn, ...nameWords];
        if (prefix.length > words.length) {
          continue;
        }
        const matches = prefix.every((expected, index) =>
          this.sameWord(expected, words[index]),
        );
        if (matches) {
          return words.slice(prefix.length).join(' ');
        }
      }
    }

    return input;
  }

  /**
   * @param awaitingPending when the previous answer is still being generated we
   * accept slightly longer follow-ups ("ну что там с ответом"), but still only
   * phrases that are *about* waiting.
   */
  parse(input: string, awaitingPending = false): ServiceCommand | null {
    const normalized = this.normalize(input);
    if (!normalized) {
      return null;
    }

    for (const definition of COMMANDS) {
      const allowance = awaitingPending && definition.command === 'pending_followup' ? 1 : 0;
      if (this.matches(normalized, definition, allowance)) {
        return definition.command;
      }
    }

    return null;
  }

  private matches(
    normalized: string,
    definition: CommandDefinition,
    extraWords: number,
  ): boolean {
    const { phrases, exact } = definition;
    const wordCount = normalized.split(' ').length;
    const maxWords = Math.max(...phrases.map((phrase) => phrase.split(' ').length)) + extraWords;

    if (wordCount > maxWords) {
      return false;
    }
    if (phrases.includes(normalized)) {
      return true;
    }
    if (exact) {
      return false;
    }

    // Tolerate a single character slip from speech recognition, but only for
    // phrases of comparable length — never as a fuzzy "contains" check.
    return phrases.some(
      (phrase) =>
        Math.abs(phrase.length - normalized.length) <= 1 &&
        this.levenshtein(phrase, normalized) <= 1,
    );
  }

  /**
   * One word matching another with a single edit of slack — enough to cover
   * Russian case endings ("дядя"/"дяди", "робот"/"робота").
   *
   * Short words demand an exact match: with one edit allowed, "у" would match
   * any other single letter.
   */
  private sameWord(expected: string, actual: string | undefined): boolean {
    if (actual === undefined) {
      return false;
    }
    if (expected === actual) {
      return true;
    }
    if (expected.length <= 2 || actual.length <= 2) {
      return false;
    }
    return (
      Math.abs(expected.length - actual.length) <= 1 && this.levenshtein(expected, actual) <= 1
    );
  }

  private levenshtein(a: string, b: string): number {
    if (a === b) {
      return 0;
    }
    const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);

    for (let i = 1; i <= a.length; i += 1) {
      let diagonal = previous[0];
      previous[0] = i;

      for (let j = 1; j <= b.length; j += 1) {
        const current = previous[j];
        previous[j] = Math.min(
          previous[j] + 1,
          previous[j - 1] + 1,
          diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        diagonal = current;
      }
    }

    return previous[b.length];
  }
}
