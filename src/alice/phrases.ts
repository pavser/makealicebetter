/** Every phrase the skill can say on its own, in one place. */
export const PHRASES = {
  greeting: 'Привет. Я готов. Спрашивай что угодно.',
  emptyCommand: 'Не расслышал. Повтори, пожалуйста.',
  help: 'Задай любой вопрос, и я отвечу. Можешь сказать: новый разговор, какая модель, переключись на Клода, или спросить «ну что», если я не успел ответить сразу.',

  pendingStarted: 'Мне нужно ещё немного времени. Спроси меня через несколько секунд: ну что?',
  pendingSearching: 'Посмотрю в интернете. Спроси меня через несколько секунд: ну что?',
  stillThinking: 'Я ещё думаю над предыдущим вопросом.',
  stillThinkingFollowUp: 'Я ещё думаю. Спроси чуть позже.',
  nothingPending: 'У меня нет готового ответа. Задай вопрос.',

  wrongSkill: 'Этот навык вызван не тем приложением.',

  turnFailed: 'Не получилось получить ответ. Попробуй ещё раз.',
  turnCancelled: 'Ответ не был получен. Попробуй спросить заново.',
  openaiError: 'Сейчас не получилось получить ответ. Попробуй ещё раз.',
  storageError: 'Сейчас не получается продолжить разговор. Попробуй чуть позже.',

  newConversation: 'Начали новый разговор. О чём поговорим?',

  modelSwitchDisabled: 'Переключение моделей не настроено.',
  modelFastSelected: 'Хорошо, со следующего вопроса буду использовать быструю модель.',
  modelSmartSelected: 'Хорошо, со следующего вопроса буду использовать умную модель.',
  modelCurrentFast: 'Сейчас используется быстрая модель.',
  modelCurrentSmart: 'Сейчас используется умная модель.',
  modelCurrentDefault: 'Сейчас используется модель по умолчанию.',

  // Switching provider cannot carry the conversation across, so the phrase says
  // so outright instead of letting the user wonder why context vanished.
  providerNotConfigured: 'Этот помощник не настроен.',
  providerClaudeSelected: 'Переключился на Клода. Разговор начат заново.',
  providerCurrentClaude: 'Сейчас отвечает Клод.',
  // Written for the card, spoken for the speaker: Alice reads "ЧатGPT" as
  // gibberish, so the tts variant spells it out.
  providerOpenAiSelected: {
    text: 'Переключился на ЧатGPT. Разговор начат заново.',
    tts: 'Переключился на чат джи пи ти. Разговор начат заново.',
  },
  providerCurrentOpenAi: {
    text: 'Сейчас отвечает ЧатGPT.',
    tts: 'Сейчас отвечает чат джи пи ти.',
  },
} as const;
