import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../config/configuration.js';
import { SpeechService } from './speech.service.js';

const configWith = (maxChars: number): ConfigService<AppConfig, true> =>
  ({
    get: () => ({ maxVoiceResponseChars: maxChars }),
  }) as unknown as ConfigService<AppConfig, true>;

describe('SpeechService', () => {
  const speech = new SpeechService(configWith(900));

  describe('markdown removal', () => {
    it('drops bold markers and keeps the sentence', () => {
      expect(speech.prepareForSpeech('**Важно:** сделать вот это').text).toBe(
        'Важно: сделать вот это',
      );
    });

    it('drops italic and inline code markers', () => {
      const { text } = speech.prepareForSpeech('Это _важно_ и вот `код` тоже');
      expect(text).toBe('Это важно и вот код тоже');
    });

    it('turns headings into sentences', () => {
      expect(speech.prepareForSpeech('## Рецепт\nБерём курицу').text).toBe('Рецепт.\nБерём курицу');
    });

    it('replaces fenced code blocks with a spoken note', () => {
      const { text } = speech.prepareForSpeech('Пример:\n```ts\nconst a = 1;\n```\nВот так');
      expect(text).not.toContain('const a = 1');
      expect(text).toContain('пример кода');
    });

    it('keeps link text and drops the URL', () => {
      expect(
        speech.prepareForSpeech('Смотри [документацию](https://example.com/very/long)').text,
      ).toBe('Смотри документацию');
    });

    it('flattens markdown tables into readable text', () => {
      const { text } = speech.prepareForSpeech(
        '| Блюдо | Время |\n| --- | --- |\n| Суп | 30 мин |',
      );
      expect(text).not.toContain('|');
      expect(text).toContain('Суп, 30 мин');
    });
  });

  describe('источники и ссылки', () => {
    it('убирает сноску на источник, которую дописывает веб-поиск', () => {
      const { text, tts } = speech.prepareForSpeech(
        'Игра сейчас в раннем доступе. (store.steampowered.com)',
      );

      expect(text).toBe('Игра сейчас в раннем доступе.');
      expect(tts).toBe('Игра сейчас в раннем доступе.');
    });

    it('убирает сноску со ссылкой целиком', () => {
      const { text } = speech.prepareForSpeech(
        'Население около 1,68 миллиона. (https://www.ksh.hu/stadat)',
      );
      expect(text).toBe('Население около 1,68 миллиона.');
    });

    it('не трогает обычные скобки', () => {
      const { text } = speech.prepareForSpeech('Это важно (и вот почему).');
      expect(text).toBe('Это важно (и вот почему).');
    });

    it('заменяет домен без протокола, если он всё же остался в тексте', () => {
      // Диктор прочитал бы его по буквам.
      const { tts } = speech.prepareForSpeech('Подробности есть на store.steampowered.com сегодня');
      expect(tts).toBe('Подробности есть на ссылка сегодня');
    });
  });

  describe('lists', () => {
    it('speaks bullet lists as an enumeration', () => {
      const { text } = speech.prepareForSpeech('- первое\n- второе\n- третье');
      expect(text).toBe('Первое: первое.\nВторое: второе.\nТретье: третье.');
    });

    it('speaks numbered lists by their position', () => {
      const { text } = speech.prepareForSpeech('1. купить\n2. нарезать');
      expect(text).toBe('Первое: купить.\nВторое: нарезать.');
    });
  });

  describe('tts', () => {
    it('replaces URLs with the word "ссылка"', () => {
      const { tts } = speech.prepareForSpeech('Подробности на https://example.com/docs/page');
      expect(tts).toBe('Подробности на ссылка');
    });

    it('collapses newlines so the speaker reads one flow', () => {
      const { tts } = speech.prepareForSpeech('Первая строка\n\nВторая строка');
      expect(tts).toBe('Первая строка Вторая строка');
    });
  });

  describe('length limiting', () => {
    const shortLimit = new SpeechService(configWith(120));

    it('cuts at a sentence boundary and offers to continue', () => {
      const long = `${'Первое предложение здесь. '.repeat(4)}Хвост который не влезет в ответ никак.`;
      const { text, truncated } = shortLimit.prepareForSpeech(long);

      expect(truncated).toBe(true);
      expect(text.length).toBeLessThanOrEqual(120);
      expect(text).toContain('Если хочешь, могу продолжить.');
      // The cut must land on a sentence end, not mid-word.
      expect(text.replace(' Если хочешь, могу продолжить.', '')).toMatch(/[.!?…]$/);
    });

    it('leaves short answers untouched', () => {
      const { text, truncated } = shortLimit.prepareForSpeech('Короткий ответ.');
      expect(truncated).toBe(false);
      expect(text).toBe('Короткий ответ.');
    });

    it('never exceeds the 1024 character limit Yandex enforces', () => {
      // Even if the configured limit were raised, the hard clamp must hold.
      const hugeLimit = new SpeechService(configWith(1024));
      const { text, tts } = hugeLimit.prepareForSpeech('а'.repeat(5000));

      expect(text.length).toBeLessThanOrEqual(1024);
      expect(tts.length).toBeLessThanOrEqual(1024);
    });
  });
});
