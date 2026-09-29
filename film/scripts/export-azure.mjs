// narration/script.md → narration/azure.txt: the narration as plain text for
// Azure Speech Studio, one chapter per block, without the markup.
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = (await readFile(new URL('narration/script.md', root), 'utf8')).replace(/\r\n/g, '\n');
const chapters = [...source.matchAll(/^## ([a-z0-9-]+): (.+)$/gm)];
if (!chapters.length) throw new Error('no chapters (## id: title) in narration/script.md');
const blocks = chapters.map((m, i) => {
  const end = chapters[i + 1] ? chapters[i + 1].index : source.length;
  const body = source.slice(m.index + m[0].length, end)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{insert [^}]*\}\}\s*/g, '')
    .replace(/\{\{\/?cue[^}]*\}\}/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return body;
});
const text = blocks.join('\n\n') + '\n';
await writeFile(new URL('narration/azure.txt', root), text);
const words = text.split(/\s+/).filter(Boolean).length;
console.log(`narration/azure.txt: ${chapters.length} chapters, ${words} words (about ${(words / 150).toFixed(1)} minutes at 150 words a minute)`);
