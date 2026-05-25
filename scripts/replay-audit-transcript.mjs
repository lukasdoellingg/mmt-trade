#!/usr/bin/env node
/**
 * Replay Write/StrReplace/Delete from agent transcript (audit phase L517-L609).
 */
import fs from 'fs';
import path from 'path';

const REPO = '/Users/lukas/Documents/mmt-trade';
const TRANSCRIPT =
  '/Users/lukas/.cursor/projects/Users-lukas-Documents-mmt-trade/agent-transcripts/aab67563-3516-4cdf-996f-007759b9bcf1/aab67563-3516-4cdf-996f-007759b9bcf1.jsonl';

const START_LINE = 517;
const END_LINE = 609;

function extractToolUses(lineObj) {
  const out = [];
  const msg = lineObj.message ?? lineObj;
  let content = msg.content;
  if (!content) return out;
  if (!Array.isArray(content)) content = [content];
  for (const item of content) {
    if (!item) continue;
    const name = item.name;
    if (name !== 'Write' && name !== 'StrReplace' && name !== 'Delete') continue;
    out.push({ name, input: item.input ?? {} });
  }
  return out;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rel(p) {
  return p?.replace(REPO + '/', '') ?? p;
}

const lines = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(Boolean);
const ops = [];

for (let i = START_LINE - 1; i < END_LINE && i < lines.length; i++) {
  const lineNum = i + 1;
  let obj;
  try {
    obj = JSON.parse(lines[i]);
  } catch {
    continue;
  }
  for (const tu of extractToolUses(obj)) {
    ops.push({ line: lineNum, ...tu });
  }
}

console.log(`Replaying ${ops.length} operations (L${START_LINE}-L${END_LINE})...\n`);

const report = {
  writes: [],
  strReplaceOk: [],
  strReplaceFail: [],
  deletes: [],
};

for (const op of ops) {
  const { name, input, line } = op;

  if (name === 'Write') {
    const filePath = input.path;
    ensureDir(filePath);
    fs.writeFileSync(filePath, input.contents ?? '', 'utf8');
    report.writes.push({ line, path: rel(filePath) });
    continue;
  }

  if (name === 'Delete') {
    const filePath = input.path;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      report.deletes.push({ line, path: rel(filePath), status: 'deleted' });
    } else {
      report.deletes.push({ line, path: rel(filePath), status: 'already absent' });
    }
    continue;
  }

  if (name === 'StrReplace') {
    const filePath = input.path;
    const { old_string, new_string } = input;
    if (!filePath || old_string === undefined) {
      report.strReplaceFail.push({ line, path: rel(filePath), reason: 'missing path or old_string' });
      continue;
    }

    if (!fs.existsSync(filePath)) {
      report.strReplaceFail.push({
        line,
        path: rel(filePath),
        reason: 'file not found',
        oldPreview: String(old_string).slice(0, 100),
      });
      continue;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(old_string)) {
      content = content.replace(old_string, new_string ?? '');
      fs.writeFileSync(filePath, content, 'utf8');
      report.strReplaceOk.push({ line, path: rel(filePath) });
    } else {
      report.strReplaceFail.push({
        line,
        path: rel(filePath),
        reason: 'old_string not found',
        oldPreview: String(old_string).slice(0, 150),
      });
    }
  }
}

console.log('=== SUMMARY ===');
console.log(`Writes: ${report.writes.length}`);
console.log(`StrReplace OK: ${report.strReplaceOk.length}`);
console.log(`StrReplace FAIL: ${report.strReplaceFail.length}`);
console.log(`Deletes: ${report.deletes.length}`);

if (report.writes.length) {
  console.log('\nWrites:');
  report.writes.forEach((w) => console.log(`  L${w.line}: ${w.path}`));
}

if (report.deletes.length) {
  console.log('\nDeletes:');
  report.deletes.forEach((d) => console.log(`  L${d.line}: ${d.path} (${d.status})`));
}

if (report.strReplaceFail.length) {
  console.log('\nFailed StrReplaces:');
  report.strReplaceFail.forEach((f) => {
    console.log(`  L${f.line}: ${f.path} — ${f.reason}`);
    if (f.oldPreview) console.log(`    preview: ${JSON.stringify(f.oldPreview)}`);
  });
}

fs.writeFileSync(path.join(REPO, 'scripts/replay-audit-report.json'), JSON.stringify(report, null, 2));
console.log('\nReport: scripts/replay-audit-report.json');
