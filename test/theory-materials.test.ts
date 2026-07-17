import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMaterialGenerationPrompt,
  buildMaterialRepairPrompt,
  listTheoryMaterials,
  loadTheoryMaterial,
  scoreTheoryMaterial,
  theoryMaterialPath,
  validateGeneratedTheoryMaterial,
  validateTheoryMaterial,
} from "../src/theory-materials.js";
import {
  correctTheoryAnswers,
  generatedTheoryMaterialFixture,
  theoryMaterialFixture,
} from "./theory-material-fixture.js";

test("builds manual and automatic topic instructions", () => {
  const manual = buildMaterialGenerationPrompt({
    materialId: "manual-material",
    topicMode: "manual",
    topic: "Замыкания",
    size: "short",
  });
  assert.match(manual, /Тема задана пользователем: «Замыкания»/);
  assert.doesNotMatch(manual, /Сам выбери одну наиболее полезную тему/);

  const automatic = buildMaterialGenerationPrompt({
    materialId: "auto-material",
    topicMode: "auto",
    size: "standard",
    notes: "Больше практических примеров",
    existingTopics: ["Замыкания", "Замыкания", "Исключения"],
  });
  assert.match(automatic, /Сам выбери одну наиболее полезную тему/);
  assert.match(automatic, /слабые места.+текущий учебный фокус.+roadmap/);
  assert.match(automatic, /Не повторяй.+«Замыкания», «Исключения»/);
  assert.match(automatic, /Запиши выбранную конкретную тему в поле topic/);
  assert.match(automatic, /Дополнительные пожелания: Больше практических примеров/);
});

test("validates all block types and fixed material sizes", () => {
  for (const size of ["short", "standard", "deep"] as const) {
    const material = theoryMaterialFixture(`material-${size}`, size);
    assert.equal(validateTheoryMaterial(material).blocks.length, material.blocks.length);
  }
});

test("keeps legacy interleaving readable and validates the new generation flow separately", () => {
  const legacy = theoryMaterialFixture("legacy-short", "short");
  assert.equal(validateTheoryMaterial(legacy).blocks.length, 6);
  assert.throws(
    () => validateGeneratedTheoryMaterial(legacy),
    /карточки должны идти после теории|объяснения должны идти перед карточками и вопросами/,
  );

  for (const size of ["short", "standard", "deep"] as const) {
    const generated = generatedTheoryMaterialFixture(`generated-${size}`, size);
    assert.equal(validateGeneratedTheoryMaterial(generated), generated);
  }

  const wrongProfile = generatedTheoryMaterialFixture("wrong-profile", "standard");
  const explanationIndex = wrongProfile.blocks.findIndex((block) => block.type === "explanation");
  const [explanation] = wrongProfile.blocks.splice(explanationIndex, 1);
  assert.ok(explanation);
  const firstQuestion = wrongProfile.blocks.findIndex((block) =>
    block.type !== "explanation" && block.type !== "flashcard"
  );
  wrongProfile.blocks.splice(firstQuestion, 0, {
    id: "extra-question",
    type: "choice",
    prompt: "Дополнительный вопрос",
    options: [{ id: "yes", text: "Да" }, { id: "no", text: "Нет" }],
    correctOptionId: "yes",
    explanation: "Пояснение.",
  });
  assert.throws(
    () => validateGeneratedTheoryMaterial(wrongProfile),
    /3 объясняющих блоков, 2 карточек и 5 вопросов/,
  );
});

test("rejects duplicate ids, invalid references, unsafe content, and wrong limits", () => {
  const duplicate = theoryMaterialFixture();
  duplicate.blocks[1]!.id = duplicate.blocks[0]!.id;
  assert.throws(() => validateTheoryMaterial(duplicate), /Повторяющийся id блока/);

  const badReference = theoryMaterialFixture();
  const choice = badReference.blocks.find((block) => block.type === "choice");
  assert.ok(choice && choice.type === "choice");
  choice.correctOptionId = "missing";
  assert.throws(() => validateTheoryMaterial(badReference), /несуществующий вариант/);

  const unsafe = theoryMaterialFixture();
  unsafe.description = "<script>alert(1)</script>";
  assert.throws(() => validateTheoryMaterial(unsafe), /запрещённый HTML/);

  const external = theoryMaterialFixture();
  external.blocks[0] = { id: "intro", type: "explanation", markdown: "![x](https://example.com/x.png)" };
  assert.throws(() => validateTheoryMaterial(external), /неподдерживаемый Markdown|внешнюю ссылку/);

  const wrongSize = theoryMaterialFixture();
  wrongSize.blocks.pop();
  assert.throws(() => validateTheoryMaterial(wrongSize), /должен содержать 10 блоков/);
});

test("loads files safely, reports corrupt JSON, and computes revisions", () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-materials-"));
  const materialsDir = join(directory, "learning", "theory", "materials");
  mkdirSync(materialsDir, { recursive: true });
  try {
    const material = theoryMaterialFixture();
    writeFileSync(join(materialsDir, "material-1.json"), JSON.stringify(material));
    const first = loadTheoryMaterial(directory, "material-1");
    material.title = "Новая версия";
    writeFileSync(join(materialsDir, "material-1.json"), JSON.stringify(material));
    const second = loadTheoryMaterial(directory, "material-1");
    assert.notEqual(first.revision, second.revision);
    assert.throws(() => theoryMaterialPath(directory, "../escape"), /Недопустимый идентификатор/);

    writeFileSync(join(materialsDir, "broken.json"), "{not json");
    writeFileSync(join(materialsDir, "huge.json"), " ".repeat(256 * 1024 + 1));
    const library = listTheoryMaterials(directory, () => null);
    assert.equal(library.materials.length, 1);
    assert.deepEqual(library.errors.map((error) => error.file), ["broken.json", "huge.json"]);
    assert.match(library.errors[0]!.message, /повреждённый JSON/);
    assert.match(library.errors[1]!.message, /256 КБ/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scores answers server-side and excludes flashcards from percentage", () => {
  const material = theoryMaterialFixture("material-short", "short");
  const answers = correctTheoryAnswers(material);
  const score = scoreTheoryMaterial(material, answers);
  assert.equal(score.correct, 3);
  assert.equal(score.total, 3);
  assert.equal(score.percentage, 100);
  assert.equal(score.resultsByBlock["card-1"]?.viewed, true);

  answers["choice-1"] = "dom";
  const retry = scoreTheoryMaterial(material, answers);
  assert.equal(retry.correct, 2);
  assert.equal(retry.percentage, 67);
  assert.deepEqual(retry.resultsByBlock["choice-1"]?.correctAnswer, "scope");

  delete answers["card-1"];
  assert.throws(() => scoreTheoryMaterial(material, answers), /ещё не просмотрена/);
});

test("builds a bounded repair request for the same generated file", () => {
  const prompt = buildMaterialRepairPrompt({
    materialId: "material-1",
    validationError: "В новых материалах все объяснения должны идти перед карточками и вопросами",
    attempt: 1,
    maximumAttempts: 2,
  });
  assert.match(prompt, /learning\/theory\/materials\/material-1\.json/);
  assert.match(prompt, /объяснения должны идти перед карточками и вопросами/);
  assert.match(prompt, /1 из 2/);
  assert.match(prompt, /не меняй никакие другие файлы/i);
});
