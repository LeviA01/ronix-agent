import type { TheoryMaterialSize, TheoryMaterialV1 } from "../src/theory-materials.js";
import { THEORY_MATERIAL_BLOCK_COUNTS } from "../src/theory-materials.js";

export function theoryMaterialFixture(
  id = "material-1",
  size: TheoryMaterialSize = "standard",
): TheoryMaterialV1 {
  const extraCount = THEORY_MATERIAL_BLOCK_COUNTS[size] - 6;
  const extras = Array.from({ length: extraCount }, (_, index) => ({
    id: `extra-${index}`,
    type: "choice" as const,
    prompt: `Дополнительный вопрос ${index + 1}`,
    options: [
      { id: "yes", text: "Верный вариант" },
      { id: "no", text: "Неверный вариант" },
    ],
    correctOptionId: "yes",
    explanation: "Короткое пояснение ответа.",
  }));
  return {
    version: 1,
    id,
    title: "Замыкания без магии",
    topic: "Замыкания JavaScript",
    description: "Понятия, карточка и короткая проверка понимания.",
    size,
    createdAt: "2026-07-15T10:00:00.000Z",
    blocks: [
      {
        id: "intro",
        type: "explanation",
        title: "Модель памяти",
        markdown: "Замыкание сохраняет **лексическое окружение**.\n\n- Функция помнит место создания.\n- Переменные остаются доступны.",
      },
      {
        id: "choice-1",
        type: "choice",
        prompt: "Что сохраняет замыкание?",
        options: [
          { id: "scope", text: "Лексическое окружение" },
          { id: "dom", text: "Только DOM-узлы" },
        ],
        correctOptionId: "scope",
        explanation: "Функция сохраняет доступ к окружению места создания.",
      },
      {
        id: "card-1",
        type: "flashcard",
        front: "Когда формируется окружение замыкания?",
        back: "В момент создания функции, а не её вызова.",
      },
      {
        id: "bridge",
        type: "explanation",
        markdown: "Теперь свяжем термины и затем восстановим порядок шагов.",
      },
      {
        id: "match-1",
        type: "matching",
        prompt: "Сопоставьте понятие и роль.",
        left: [
          { id: "closure", text: "Замыкание" },
          { id: "scope", text: "Область видимости" },
        ],
        right: [
          { id: "remember", text: "Помнит окружение" },
          { id: "access", text: "Определяет доступные имена" },
        ],
        pairs: [
          { leftId: "closure", rightId: "remember" },
          { leftId: "scope", rightId: "access" },
        ],
        explanation: "Замыкание использует правила лексической области видимости.",
      },
      ...extras,
      {
        id: "order-1",
        type: "ordering",
        prompt: "Расположите события по порядку.",
        items: [
          { id: "create", text: "Создать внешнюю функцию" },
          { id: "return", text: "Вернуть внутреннюю функцию" },
          { id: "call", text: "Вызвать внутреннюю функцию" },
        ],
        correctOrder: ["create", "return", "call"],
        explanation: "Сначала создаётся окружение, затем функция возвращается и вызывается.",
      },
    ],
  };
}

export function correctTheoryAnswers(material: TheoryMaterialV1): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const block of material.blocks) {
    if (block.type === "choice") answers[block.id] = block.correctOptionId;
    if (block.type === "flashcard") answers[block.id] = true;
    if (block.type === "matching") {
      answers[block.id] = Object.fromEntries(block.pairs.map((pair) => [pair.leftId, pair.rightId]));
    }
    if (block.type === "ordering") answers[block.id] = block.correctOrder;
  }
  return answers;
}
