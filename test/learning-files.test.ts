import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readLearningFile, roadmapSummary } from "../src/learning-files.js";

test("roadmap summary keeps custom blocks, continuations, completion and the next unfinished topic", () => {
  const source = '# Карта\n## Сейчас\n- [x] Функции, JSON и\n  сохранение состояния.\n## Завершённый блок pytest\n- [x] Проверить\n  `pytest.raises`.\n## Ближайший блок\n- [x] Массивы\n- [ ] Освоить выбор\n  по условию.\n## Позже\n- [ ] pandas\n## История корректировок\n- Сохранить историю.';
  const summary = roadmapSummary(source);
  assert.equal(summary.current[0]?.title, 'Функции, JSON и сохранение состояния.');
  assert.equal(summary.currentStage, 'Освоить выбор по условию.');
  assert.deepEqual(summary.completed, ['Функции, JSON и сохранение состояния.', 'Проверить pytest.raises.', 'Массивы']);
  assert.equal(summary.sections.at(-1)?.title, 'История корректировок');
});

test("learning files remain verbatim, reflect edits, support filename case and reject outside symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), 'ronix-learning-files-'));
  try {
    const project = join(root, 'project'); mkdirSync(join(project, 'learning'), { recursive: true });
    const path = join(project, 'learning', 'Roadmap.md');
    const text = '# Мой маршрут\n\n## Произвольный раздел\n- [ ] Шаг\n  продолжение\n';
    writeFileSync(path, text);
    assert.equal(readLearningFile(project, 'ROADMAP.md'), text);
    writeFileSync(path, text + '\nИстория\n');
    assert.equal(readLearningFile(project, 'ROADMAP.md'), text + '\nИстория\n');
    assert.equal(readLearningFile(project, 'LEARNING_DIARY.md'), '');
    writeFileSync(join(project, 'learning', 'ROADMAP.md'), text);
    assert.throws(() => readLearningFile(project, 'ROADMAP.md'), /Несколько/);
    writeFileSync(join(root, 'outside'), 'private');
    symlinkSync(join(root, 'outside'), join(project, 'learning', 'LEARNING_DIARY.md'));
    assert.throws(() => readLearningFile(project, 'LEARNING_DIARY.md'), /вне проекта/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
