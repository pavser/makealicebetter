import { Injectable } from '@nestjs/common';

export type ServiceCommand =
  'new_conversation' | 'model_fast' | 'model_smart' | 'which_model' | 'pending_followup' | 'help';

interface CommandDefinition {
  command: ServiceCommand;
  phrases: string[];
}

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
    return input
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[.,!?;:"'«»()\-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
      if (this.matches(normalized, definition.phrases, allowance)) {
        return definition.command;
      }
    }

    return null;
  }

  private matches(normalized: string, phrases: string[], extraWords: number): boolean {
    const wordCount = normalized.split(' ').length;
    const maxWords = Math.max(...phrases.map((phrase) => phrase.split(' ').length)) + extraWords;

    if (wordCount > maxWords) {
      return false;
    }
    if (phrases.includes(normalized)) {
      return true;
    }

    // Tolerate a single character slip from speech recognition, but only for
    // phrases of comparable length — never as a fuzzy "contains" check.
    return phrases.some(
      (phrase) =>
        Math.abs(phrase.length - normalized.length) <= 1 &&
        this.levenshtein(phrase, normalized) <= 1,
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
