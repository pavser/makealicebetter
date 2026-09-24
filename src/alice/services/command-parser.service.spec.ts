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
