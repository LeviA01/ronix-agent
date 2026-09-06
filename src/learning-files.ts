import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { HttpError } from "./http.js";

export function readLearningFile(projectPath: string, name: string): string {
  const root = join(projectPath, "learning");
  if (!existsSync(root)) return "";
  const matches = readdirSync(root).filter(entry => entry.toLowerCase() === name.toLowerCase());
  if (matches.length > 1) throw new HttpError(409, `Несколько вариантов файла ${name} в learning`);
  if (!matches.length) return "";
  const path = realpathSync(join(root, matches[0]!));
  const rel = relative(realpathSync(projectPath), path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new HttpError(403, "Учебный файл находится вне проекта");
  if (statSync(path).size > 1_000_000) throw new HttpError(413, "Learning file is too large");
  return readFileSync(path, "utf8");
}

export function roadmapSummary(markdown: string) {
  type Item = { title: string; done: boolean };
  const sections: Array<{ title: string; items: Item[] }> = [];
  let section = { title: "", items: [] as Item[] }; sections.push(section);
  let item: Item | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { section = { title: heading[1]!, items: [] }; sections.push(section); item = undefined; continue; }
    const check = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (check) { item = { title: check[2]!.trim(), done: check[1]!.toLowerCase() === "x" }; section.items.push(item); }
    else if (item && /^\s+\S/.test(line)) item.title += " " + line.trim();
    else if (line.trim()) item = undefined;
  }
  const clean = (item: Item): Item => ({ ...item, title: item.title.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1") });
  const current = sections.filter(s => /^(сейчас|текущий блок)$/i.test(s.title)).flatMap(s => s.items).map(clean);
  const later = sections.filter(s => /^(позже|долгосрочные планы)$/i.test(s.title)).flatMap(s => s.items).map(clean);
  const nextSteps = sections.filter(s => !/^(сейчас|текущий блок|позже|долгосрочные планы)$/i.test(s.title)).flatMap(s => s.items).map(clean);
  const all = sections.flatMap(s => s.items).map(clean);
  return { sections, current, nextSteps, later, completed: all.filter(i => i.done).map(i => i.title),
    currentStage: [...current, ...nextSteps, ...later].find(i => !i.done)?.title ?? null };
}
