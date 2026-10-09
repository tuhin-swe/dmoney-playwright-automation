// @ts-check
const fs = require('fs');
const path = require('path');

/** Local YYYY-MM-DD (not UTC) for the required file name. */
function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function escapeCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Write an array of row-objects to `test-data/self_statement_<today>.csv`.
 * Returns the absolute path written.
 */
function writeSelfStatementCsv(rows, outDir = path.join(process.cwd(), 'test-data')) {
  fs.mkdirSync(outDir, { recursive: true });
  const headers = rows.length
    ? Object.keys(rows[0])
    : ['Transaction ID', 'Sender Account', 'Receiver Account', 'Type', 'Debit', 'Credit', 'Balance', 'Date'];
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  const file = path.join(outDir, `self_statement_${todayStamp()}.csv`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

module.exports = { writeSelfStatementCsv, todayStamp };
