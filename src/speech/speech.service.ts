import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../config/configuration.js';
import { ALICE_TEXT_HARD_LIMIT } from '../config/env.validation.js';

export interface SpokenAnswer {
  /** Shown in the Alice app; closest readable form of the answer. */
  text: string;
  /** Optimised for the speaker: no URLs, no leftover punctuation noise. */
  tts: string;
  truncated: boolean;
}

const CONTINUATION_HINT = ' Если хочешь, могу продолжить.';
const ORDINALS = ['Первое', 'Второе', 'Третье', 'Четвёртое', 'Пятое', 'Шестое', 'Седьмое'];

/**
 * Turns model output into something a speaker can read aloud.
 *
 * Even though the saved Agent is instructed to avoid markdown, this stays as a
 * second line of defence: models still emit bold, lists and links now and then,
 * and Alice would read the raw characters out loud.
 */
@Injectable()
export class SpeechService {
  private readonly maxChars: number;

  constructor(config: ConfigService<AppConfig, true>) {
    this.maxChars = Math.min(
      config.get('alice', { infer: true }).maxVoiceResponseChars,
      ALICE_TEXT_HARD_LIMIT,
    );
  }

  prepareForSpeech(raw: string): SpokenAnswer {
    const plain = this.stripMarkdown(raw);
    const { text, truncated } = this.limitLength(plain);
    return {
      text: this.clampHard(text),
      tts: this.clampHard(this.toTts(text)),
      truncated,
    };
  }

  private stripMarkdown(input: string): string {
    let text = input.replace(/\r\n/g, '\n');

    // Fenced code blocks are unreadable aloud — announce them instead.
    text = text.replace(/```[\s\S]*?```/g, ' Дальше был пример кода. ');
    text = text.replace(/~~~[\s\S]*?~~~/g, ' Дальше был пример кода. ');

    // Images before links: ![alt](url) -> alt
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Links: [text](url) -> text
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/gm, (_match, heading: string) =>
      /[.!?:…]$/.test(heading) ? heading : `${heading}.`,
    );
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/__([^_]+)__/g, '$1');
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2');
    text = text.replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2');
    text = text.replace(/~~([^~]+)~~/g, '$1');

    // Tables: keep the cells, drop the pipes and separator rows.
    text = text.replace(/^\s*\|?[\s:-]*\|[\s|:-]*$/gm, '');
    text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_match, row: string) =>
      row
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(', '),
    );

    text = text.replace(/^\s{0,3}>\s?/gm, '');
    text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '');

    text = this.speakLists(text);

    return text
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim();
  }

  /** Rewrites list markers as spoken enumerations ("Первое, ... Второе, ..."). */
  private speakLists(text: string): string {
    const lines = text.split('\n');
    let bulletIndex = 0;

    const result = lines.map((line) => {
      const bullet = /^\s{0,4}[-*•]\s+(.*)$/.exec(line);
      if (bullet) {
        const item = this.ensureSentenceEnd(bullet[1].trim());
        const prefix = ORDINALS[bulletIndex] ?? `${bulletIndex + 1}`;
        bulletIndex += 1;
        return `${prefix}: ${item}`;
      }

      const numbered = /^\s{0,4}(\d{1,2})[.)]\s+(.*)$/.exec(line);
      if (numbered) {
        bulletIndex = 0;
        const position = Number(numbered[1]);
        const item = this.ensureSentenceEnd(numbered[2].trim());
        const prefix = ORDINALS[position - 1] ?? `${position}`;
        return `${prefix}: ${item}`;
      }

      if (line.trim() === '') {
        bulletIndex = 0;
      }
      return line;
    });

    return result.join('\n');
  }

  private ensureSentenceEnd(value: string): string {
    return /[.!?…:]$/.test(value) ? value : `${value}.`;
  }

  private limitLength(text: string): { text: string; truncated: boolean } {
    if (text.length <= this.maxChars) {
      return { text, truncated: false };
    }

    const budget = this.maxChars - CONTINUATION_HINT.length;
    const slice = text.slice(0, Math.max(budget, 1));

    // Prefer cutting at the end of a sentence; fall back to a word boundary so
    // the speaker never stops mid-word.
    const sentenceEnd = /^[\s\S]*[.!?…](?=[\s"»)]|$)/.exec(slice);
    let cut = sentenceEnd?.[0] ?? '';

    if (cut.length < budget * 0.4) {
      const lastSpace = slice.lastIndexOf(' ');
      cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
    }

    return { text: `${cut.trim()}${CONTINUATION_HINT}`, truncated: true };
  }

  private toTts(text: string): string {
    return text
      .replace(/https?:\/\/\S+/gi, 'ссылка')
      .replace(/\bwww\.\S+/gi, 'ссылка')
      .replace(/[#*_`~|<>]/g, '')
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** Yandex Dialogs rejects text or tts longer than 1024 characters. */
  private clampHard(value: string): string {
    return value.length <= ALICE_TEXT_HARD_LIMIT ? value : value.slice(0, ALICE_TEXT_HARD_LIMIT);
  }
}
