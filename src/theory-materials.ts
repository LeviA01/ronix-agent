import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import type { TheoryMaterialAttempt } from "./types.js";

export const THEORY_MATERIAL_MAX_BYTES = 256 * 1024;
export const THEORY_MATERIAL_BLOCK_COUNTS = {
  short: 6,
  standard: 10,
  deep: 16,
} as const;

export type TheoryMaterialSize = keyof typeof THEORY_MATERIAL_BLOCK_COUNTS;

type MaterialMeta = {
  version: 1;
  id: string;
  title: string;
  topic: string;
  description?: string;
  size: TheoryMaterialSize;
  createdAt: string;
};

export type ExplanationBlock = {
  id: string;
  type: "explanation";
  title?: string;
  markdown: string;
};

export type ChoiceBlock = {
  id: string;
  type: "choice";
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId: string;
  explanation: string;
};

export type FlashcardBlock = {
  id: string;
  type: "flashcard";
  front: string;
  back: string;
};

export type MatchingBlock = {
  id: string;
  type: "matching";
  prompt: string;
  left: Array<{ id: string; text: string }>;
  right: Array<{ id: string; text: string }>;
  pairs: Array<{ leftId: string; rightId: string }>;
  explanation: string;
};

export type OrderingBlock = {
  id: string;
  type: "ordering";
  prompt: string;
  items: Array<{ id: string; text: string }>;
  correctOrder: string[];
  explanation: string;
};

export type TheoryMaterialBlock =
  | ExplanationBlock
  | ChoiceBlock
  | FlashcardBlock
  | MatchingBlock
  | OrderingBlock;

export type TheoryMaterialV1 = MaterialMeta & {
  blocks: TheoryMaterialBlock[];
};

export type LoadedTheoryMaterial = {
  material: TheoryMaterialV1;
  revision: string;
  bytes: number;
};

export type TheoryMaterialSummary = MaterialMeta & {
  blockCount: number;
  interactiveCount: number;
  revision: string;
  lastAttempt: TheoryMaterialAttempt | null;
};

export type TheoryMaterialBlockResult = {
  correct?: boolean;
  viewed?: boolean;
  correctAnswer?: unknown;
  explanation?: string;
};

export type TheoryMaterialScore = {
  correct: number;
  total: number;
  percentage: number;
  resultsByBlock: Record<string, TheoryMaterialBlockResult>;
};

export class TheoryMaterialError extends Error {
  constructor(message: string, readonly code = "INVALID_MATERIAL") {
    super(message);
  }
}

export function theoryMaterialsDirectory(projectPath: string): string {
  return join(projectPath, "learning", "theory", "materials");
}

export function ensureTheoryMaterialsDirectory(projectPath: string): string {
  const directory = theoryMaterialsDirectory(projectPath);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function theoryMaterialPath(projectPath: string, materialId: string): string {
  assertMaterialId(materialId);
  const directory = resolve(theoryMaterialsDirectory(projectPath));
  const filePath = resolve(directory, `${materialId}.json`);
  if (!filePath.startsWith(directory + sep)) {
    throw new TheoryMaterialError("Недопустимый идентификатор материала", "INVALID_ID");
  }
  return filePath;
}

export function loadTheoryMaterial(projectPath: string, materialId: string): LoadedTheoryMaterial {
  const filePath = theoryMaterialPath(projectPath, materialId);
  if (!existsSync(filePath)) throw new TheoryMaterialError("Материал не найден", "NOT_FOUND");
  const size = statSync(filePath).size;
  if (size > THEORY_MATERIAL_MAX_BYTES) {
    throw new TheoryMaterialError("Файл материала превышает лимит 256 КБ", "TOO_LARGE");
  }
  const bytes = readFileSync(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TheoryMaterialError("Файл содержит повреждённый JSON");
  }
  const material = validateTheoryMaterial(parsed, materialId);
  return {
    material,
    revision: createHash("sha256").update(bytes).digest("hex"),
    bytes: size,
  };
}

export function listTheoryMaterials(
  projectPath: string,
  attemptFor: (materialId: string, revision: string) => TheoryMaterialAttempt | null,
): { materials: TheoryMaterialSummary[]; errors: Array<{ file: string; message: string }> } {
  const directory = theoryMaterialsDirectory(projectPath);
  if (!existsSync(directory)) return { materials: [], errors: [] };
  const materials: TheoryMaterialSummary[] = [];
  const errors: Array<{ file: string; message: string }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const materialId = entry.name.slice(0, -5);
    try {
      const loaded = loadTheoryMaterial(projectPath, materialId);
      const { blocks, ...meta } = loaded.material;
      materials.push({
        ...meta,
        blockCount: blocks.length,
        interactiveCount: blocks.filter((block) => block.type !== "explanation").length,
        revision: loaded.revision,
        lastAttempt: attemptFor(materialId, loaded.revision),
      });
    } catch (error) {
      errors.push({
        file: entry.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  materials.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  errors.sort((a, b) => a.file.localeCompare(b.file));
  return { materials, errors };
}

export function deleteTheoryMaterial(projectPath: string, materialId: string): boolean {
  const filePath = theoryMaterialPath(projectPath, materialId);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

export function validateTheoryMaterial(value: unknown, expectedId?: string): TheoryMaterialV1 {
  const record = objectValue(value, "Корень материала должен быть JSON-объектом");
  exactKeys(record, ["version", "id", "title", "topic", "description", "size", "createdAt", "blocks"]);
  if (record.version !== 1) fail("version должен быть равен 1");
  const id = idValue(record.id, "id");
  if (expectedId && id !== expectedId) fail(`id должен совпадать с именем файла: ${expectedId}`);
  const size = enumValue(record.size, Object.keys(THEORY_MATERIAL_BLOCK_COUNTS), "size") as TheoryMaterialSize;
  const createdAt = textValue(record.createdAt, "createdAt", 64, false);
  if (Number.isNaN(Date.parse(createdAt))) fail("createdAt должен быть датой ISO 8601");
  if (!Array.isArray(record.blocks)) fail("blocks должен быть массивом");
  if (record.blocks.length !== THEORY_MATERIAL_BLOCK_COUNTS[size]) {
    fail(`Размер ${size} должен содержать ${THEORY_MATERIAL_BLOCK_COUNTS[size]} блоков`);
  }

  const ids = new Set<string>();
  const blocks = record.blocks.map((block, index) => {
    const parsed = validateBlock(block, index);
    if (ids.has(parsed.id)) fail(`Повторяющийся id блока: ${parsed.id}`);
    ids.add(parsed.id);
    return parsed;
  });
  const types = new Set(blocks.map((block) => block.type));
  for (const type of ["explanation", "choice", "flashcard", "matching", "ordering"] as const) {
    if (!types.has(type)) fail(`Набор должен содержать блок типа ${type}`);
  }
  const interactiveIndexes = blocks
    .map((block, index) => block.type === "explanation" ? -1 : index)
    .filter((index) => index >= 0);
  const firstInteractive = Math.min(...interactiveIndexes);
  const lastInteractive = Math.max(...interactiveIndexes);
  if (!blocks.some((block, index) =>
    block.type === "explanation" && index > firstInteractive && index < lastInteractive
  )) {
    fail("Объясняющие блоки должны быть распределены между интерактивными");
  }

  return {
    version: 1,
    id,
    title: textValue(record.title, "title", 160, false),
    topic: textValue(record.topic, "topic", 160, false),
    ...(record.description === undefined
      ? {}
      : { description: textValue(record.description, "description", 500, true) }),
    size,
    createdAt,
    blocks,
  };
}

export function scoreTheoryMaterial(
  material: TheoryMaterialV1,
  answersByBlock: unknown,
): TheoryMaterialScore {
  const answers = objectValue(answersByBlock, "answersByBlock должен быть объектом");
  const resultsByBlock: Record<string, TheoryMaterialBlockResult> = {};
  let correct = 0;
  let total = 0;

  for (const block of material.blocks) {
    if (block.type === "explanation") continue;
    const answer = answers[block.id];
    if (block.type === "flashcard") {
      if (answer !== true) fail(`Карточка ${block.id} ещё не просмотрена`, "INCOMPLETE_ATTEMPT");
      resultsByBlock[block.id] = { viewed: true };
      continue;
    }
    total += 1;
    if (block.type === "choice") {
      if (typeof answer !== "string") fail(`Нет ответа для блока ${block.id}`, "INCOMPLETE_ATTEMPT");
      const isCorrect = answer === block.correctOptionId;
      if (isCorrect) correct += 1;
      resultsByBlock[block.id] = {
        correct: isCorrect,
        correctAnswer: block.correctOptionId,
        explanation: block.explanation,
      };
      continue;
    }
    if (block.type === "matching") {
      const mapping = objectValue(answer, `Нет полного ответа для блока ${block.id}`, "INCOMPLETE_ATTEMPT");
      const leftIds = new Set(block.left.map((item) => item.id));
      if (Object.keys(mapping).length !== leftIds.size) {
        fail(`Нет полного ответа для блока ${block.id}`, "INCOMPLETE_ATTEMPT");
      }
      const expected = Object.fromEntries(block.pairs.map((pair) => [pair.leftId, pair.rightId]));
      const isCorrect = [...leftIds].every((leftId) => mapping[leftId] === expected[leftId]);
      if (isCorrect) correct += 1;
      resultsByBlock[block.id] = {
        correct: isCorrect,
        correctAnswer: expected,
        explanation: block.explanation,
      };
      continue;
    }
    if (!Array.isArray(answer) || answer.length !== block.items.length) {
      fail(`Нет полного ответа для блока ${block.id}`, "INCOMPLETE_ATTEMPT");
    }
    const answerOrder = answer.map(String);
    const isCorrect = answerOrder.every((id, index) => id === block.correctOrder[index]);
    if (isCorrect) correct += 1;
    resultsByBlock[block.id] = {
      correct: isCorrect,
      correctAnswer: block.correctOrder,
      explanation: block.explanation,
    };
  }

  return {
    correct,
    total,
    percentage: total ? Math.round(correct / total * 100) : 0,
    resultsByBlock,
  };
}

export function buildMaterialGenerationPrompt(input: {
  materialId: string;
  topic: string;
  size: TheoryMaterialSize;
  notes?: string;
}): string {
  const count = THEORY_MATERIAL_BLOCK_COUNTS[input.size];
  const notes = input.notes?.trim() ? `\nДополнительные пожелания: ${input.notes.trim()}` : "";
  return `Создай интерактивный материал по теме «${input.topic}».\nРазмер: ${input.size}, ровно ${count} блоков.${notes}\n\nОжидаемый файл: learning/theory/materials/${input.materialId}.json\n\nПеред созданием прочитай learning/LEARNING_DIARY.md и learning/ROADMAP.md, чтобы подобрать уровень, текущий фокус и слабые места. Запиши только ожидаемый JSON-файл и не изменяй никакие другие файлы.\n\nJSON обязан иметь поля version=1, id="${input.materialId}", title, topic, description, size="${input.size}", createdAt в ISO 8601 и blocks. Используй все типы блоков и распределяй объяснения между интерактивными блоками:\n- explanation: { id, type, title?, markdown }\n- choice: { id, type, prompt, options:[{id,text}], correctOptionId, explanation }\n- flashcard: { id, type, front, back }\n- matching: { id, type, prompt, left:[{id,text}], right:[{id,text}], pairs:[{leftId,rightId}], explanation }\n- ordering: { id, type, prompt, items:[{id,text}], correctOrder:[id], explanation }\n\nВсе id уникальны в своей области. Ссылки correctOptionId, pairs и correctOrder должны указывать на существующие элементы. Не используй HTML, JavaScript, CSS, внешние ссылки, изображения или медиа. Markdown допустим только в markdown объясняющих блоков: абзацы, списки, **жирный текст** и встроенный \`код\`. После записи файла не запускай и не изменяй исходный код проекта.`;
}

function validateBlock(value: unknown, index: number): TheoryMaterialBlock {
  const record = objectValue(value, `Блок ${index + 1} должен быть объектом`);
  const type = enumValue(
    record.type,
    ["explanation", "choice", "flashcard", "matching", "ordering"],
    `blocks[${index}].type`,
  ) as TheoryMaterialBlock["type"];
  const id = idValue(record.id, `blocks[${index}].id`);
  if (type === "explanation") {
    exactKeys(record, ["id", "type", "title", "markdown"]);
    return {
      id,
      type,
      ...(record.title === undefined ? {} : { title: plainText(record.title, `${id}.title`, 160) }),
      markdown: markdownText(record.markdown, `${id}.markdown`, 8_000),
    };
  }
  if (type === "choice") {
    exactKeys(record, ["id", "type", "prompt", "options", "correctOptionId", "explanation"]);
    const options = itemList(record.options, `${id}.options`, 2, 8);
    const correctOptionId = idValue(record.correctOptionId, `${id}.correctOptionId`);
    if (!options.some((option) => option.id === correctOptionId)) {
      fail(`${id}.correctOptionId ссылается на несуществующий вариант`);
    }
    return {
      id,
      type,
      prompt: plainText(record.prompt, `${id}.prompt`, 1_000),
      options,
      correctOptionId,
      explanation: plainText(record.explanation, `${id}.explanation`, 2_000),
    };
  }
  if (type === "flashcard") {
    exactKeys(record, ["id", "type", "front", "back"]);
    return {
      id,
      type,
      front: plainText(record.front, `${id}.front`, 1_000),
      back: plainText(record.back, `${id}.back`, 2_000),
    };
  }
  if (type === "matching") {
    exactKeys(record, ["id", "type", "prompt", "left", "right", "pairs", "explanation"]);
    const left = itemList(record.left, `${id}.left`, 2, 8);
    const right = itemList(record.right, `${id}.right`, 2, 8);
    if (left.length !== right.length) fail(`${id}: число элементов слева и справа должно совпадать`);
    if (!Array.isArray(record.pairs) || record.pairs.length !== left.length) {
      fail(`${id}.pairs должен содержать по одной паре для каждого элемента`);
    }
    const leftIds = new Set(left.map((item) => item.id));
    const rightIds = new Set(right.map((item) => item.id));
    const pairedLeft = new Set<string>();
    const pairedRight = new Set<string>();
    const pairs = record.pairs.map((pair, pairIndex) => {
      const pairRecord = objectValue(pair, `${id}.pairs[${pairIndex}] должен быть объектом`);
      exactKeys(pairRecord, ["leftId", "rightId"]);
      const leftId = idValue(pairRecord.leftId, `${id}.pairs[${pairIndex}].leftId`);
      const rightId = idValue(pairRecord.rightId, `${id}.pairs[${pairIndex}].rightId`);
      if (!leftIds.has(leftId) || !rightIds.has(rightId)) fail(`${id}.pairs содержит неверную ссылку`);
      if (pairedLeft.has(leftId) || pairedRight.has(rightId)) fail(`${id}.pairs содержит повторную связь`);
      pairedLeft.add(leftId);
      pairedRight.add(rightId);
      return { leftId, rightId };
    });
    return {
      id,
      type,
      prompt: plainText(record.prompt, `${id}.prompt`, 1_000),
      left,
      right,
      pairs,
      explanation: plainText(record.explanation, `${id}.explanation`, 2_000),
    };
  }
  exactKeys(record, ["id", "type", "prompt", "items", "correctOrder", "explanation"]);
  const items = itemList(record.items, `${id}.items`, 2, 10);
  if (!Array.isArray(record.correctOrder) || record.correctOrder.length !== items.length) {
    fail(`${id}.correctOrder должен содержать все элементы`);
  }
  const itemIds = new Set(items.map((item) => item.id));
  const correctOrder = record.correctOrder.map((item, itemIndex) =>
    idValue(item, `${id}.correctOrder[${itemIndex}]`)
  );
  if (new Set(correctOrder).size !== items.length || correctOrder.some((item) => !itemIds.has(item))) {
    fail(`${id}.correctOrder содержит неверные или повторяющиеся ссылки`);
  }
  return {
    id,
    type,
    prompt: plainText(record.prompt, `${id}.prompt`, 1_000),
    items,
    correctOrder,
    explanation: plainText(record.explanation, `${id}.explanation`, 2_000),
  };
}

function itemList(value: unknown, field: string, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${field} должен содержать от ${minimum} до ${maximum} элементов`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const record = objectValue(item, `${field}[${index}] должен быть объектом`);
    exactKeys(record, ["id", "text"]);
    const id = idValue(record.id, `${field}[${index}].id`);
    if (seen.has(id)) fail(`${field} содержит повторяющийся id ${id}`);
    seen.add(id);
    return { id, text: plainText(record.text, `${field}[${index}].text`, 1_000) };
  });
}

function assertMaterialId(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new TheoryMaterialError("Недопустимый идентификатор материала", "INVALID_ID");
  }
}

function idValue(value: unknown, field: string): string {
  const result = textValue(value, field, 64, false);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) fail(`${field} содержит недопустимый id`);
  return result;
}

function plainText(value: unknown, field: string, maximum: number): string {
  const result = textValue(value, field, maximum, false);
  if (/```|!\[|\[[^\]]+\]\([^)]*\)|(^|\n)\s{0,3}#{1,6}\s|(^|\n)\s*[-*+]\s/m.test(result)) {
    fail(`Markdown разрешён только в explanation.markdown: ${field}`);
  }
  return result;
}

function markdownText(value: unknown, field: string, maximum: number): string {
  const result = textValue(value, field, maximum, false);
  if (/```|!\[|\[[^\]]+\]\([^)]*\)/.test(result)) {
    fail(`${field} содержит неподдерживаемый Markdown`);
  }
  return result;
}

function textValue(value: unknown, field: string, maximum: number, allowEmpty: boolean): string {
  if (typeof value !== "string") fail(`${field} должен быть строкой`);
  const result = value.trim();
  if (!allowEmpty && !result) fail(`${field} не должен быть пустым`);
  if (result.length > maximum) fail(`${field} превышает лимит ${maximum} символов`);
  if (result.split(/\r?\n/).length > 120) fail(`${field} содержит слишком много строк`);
  if (/<\s*\/?\s*[a-z][^>]*>/i.test(result)) fail(`${field} содержит запрещённый HTML`);
  if (/(?:https?:|data:|javascript:|file:|\/\/)[^\s]*/i.test(result)) {
    fail(`${field} содержит запрещённую внешнюю ссылку или URI`);
  }
  if (/(?:<\/?script|<\/?style|on\w+\s*=)/i.test(result)) fail(`${field} содержит исполняемый контент`);
  return result;
}

function enumValue(value: unknown, allowed: string[], field: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(`${field} должен быть одним из: ${allowed.join(", ")}`);
  }
  return value;
}

function objectValue(
  value: unknown,
  message: string,
  code = "INVALID_MATERIAL",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(message, code);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: string[]): void {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length) fail(`Неизвестные поля: ${extras.join(", ")}`);
}

function fail(message: string, code = "INVALID_MATERIAL"): never {
  throw new TheoryMaterialError(message, code);
}
