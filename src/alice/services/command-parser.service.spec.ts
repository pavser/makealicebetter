import { CommandParserService } from './command-parser.service.js';

describe('CommandParserService', () => {
  const parser = new CommandParserService();

  describe('normalize', () => {
    it('lowercases, strips punctuation and collapses spaces', () => {
      expect(parser.normalize('  Новый,   РАЗГОВОР!  ')).toBe('новый разговор');
    });

    it('folds ё to е so "начнём" matches "начнем"', () => {
      expect(parser.normalize('Ещё')).toBe('еще');
    });
  });

  describe('service commands', () => {
    it.each([
      ['новый разговор', 'new_conversation'],
      ['Начни новый разговор', 'new_conversation'],
      ['забудь текущий разговор', 'new_conversation'],
      ['быстрая модель', 'model_fast'],
      ['Используй быструю модель', 'model_fast'],
      ['умная модель', 'model_smart'],
      ['используй умную модель', 'model_smart'],
      ['какая модель', 'which_model'],
      ['Какую модель ты используешь?', 'which_model'],
      ['помощь', 'help'],
    ])('recognises "%s"', (utterance, expected) => {
      expect(parser.parse(utterance)).toBe(expected);
    });

    it.each(['ну что', 'готово', 'что там', 'есть ответ', 'ответ готов', 'что получилось'])(
      'recognises the pending follow-up "%s"',
      (utterance) => {
        expect(parser.parse(utterance)).toBe('pending_followup');
      },
    );

    it('tolerates a single speech-recognition slip', () => {
      expect(parser.parse('готов')).toBe('pending_followup');
    });
  });

  describe('provider names as speech recognition writes them', () => {
    // Yandex renders brands in Latin as readily as in Cyrillic, and reads
    // "ChatGPT" out syllable by syllable. Only the Cyrillic spelling was
    // listed at first, so the command reached the model, which politely
    // explained that it is Alice and cannot switch to anything.
    it.each([
      // The two that actually failed at the speaker, copied from the
      // production `messages` table: Latin, and mixed with Cyrillic.
      'переключись на open ai',
      'переключись на чат gpt',
      'переключись на чатгпт',
      'переключись на чат гпт',
      'переключись на чат джи пи ти',
      'переключись на джипити',
      'переключись на chatgpt',
      'переключись на chat gpt',
      'переключись на gpt',
      'переключись на опенай',
      'переключись на опен ай',
      'переключись на опен эй ай',
      'переключись на openai',
      'переключись на open ai',
      'давай чатгпт',
      'верни чатгпт',
    ])('recognises "%s"', (utterance) => {
      expect(parser.parse(utterance)).toBe('provider_openai');
    });

    it.each([
      'переключись на клода',
      'переключись на клод',
      'переключись на клауд',
      'переключись на claude',
      'спроси у клода',
      'давай клода',
    ])('recognises "%s"', (utterance) => {
      expect(parser.parse(utterance)).toBe('provider_claude');
    });

    // Switching archives the conversation, so this command gives up the
    // one-typo tolerance the others have: "теперь код" is a single character
    // away from "теперь клод" and is a perfectly normal thing to say.
    it.each([
      'теперь код',
      'давай код',
      'включи свет',
      'переключи канал',
      'что такое чатгпт',
      'расскажи про gpt модели',
    ])('leaves "%s" to the model', (utterance) => {
      expect(parser.parse(utterance)).toBeNull();
    });
  });

  describe('does not match ordinary speech', () => {
    // The whole point of the strict matcher: a normal sentence that happens to
    // contain a command phrase must reach the model, not trigger a command.
    it.each([
      'Расскажи, что там происходило в Сталкере',
      'Что там с погодой в Москве на выходных',
      'Какая модель телефона лучше для съёмки видео',
      'Расскажи про новый разговор с инвесторами',
      'Мне нужна помощь с настройкой роутера',
    ])('treats "%s" as a normal question', (utterance) => {
      expect(parser.parse(utterance)).toBeNull();
    });

    it('stays strict even while waiting for a pending answer', () => {
      expect(parser.parse('Расскажи, что там происходило в Сталкере', true)).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(parser.parse('   ')).toBeNull();
    });
  });
});
