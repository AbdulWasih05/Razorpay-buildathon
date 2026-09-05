import { useEffect, useState } from 'react';

import { fetchEvalReport } from './api.js';

/**
 * The metrics page (TASKS.md P4.2).
 *
 * Its acceptance criterion is "matches `eval/results.md` numbers exactly", and
 * the only way to guarantee that without a second thing to keep in step is to
 * render the report itself. So this fetches the committed markdown from the API
 * and lays it out. There is no computation here at all: no totals, no
 * percentages, no rounding. If the number on this page is wrong, the report is
 * wrong, and there is exactly one place to fix it.
 *
 * That also settles hard rule #6 for free. Every caveat travels with its
 * number -- the ₹0 false-positive cost arrives with the paragraph saying what
 * zero does and does not show, and the recall figure arrives with the
 * limitations under it. A hand-built dashboard is precisely where those
 * sentences get dropped, because a chart has nowhere to put them.
 *
 * The renderer is deliberately about forty lines and understands four things:
 * headings, pipe tables, list items, and paragraphs. That is everything the
 * report contains. A markdown library the day before a feature freeze would be
 * a new dependency, a new build surface and a new class of bug, to display a
 * document whose shape we control.
 */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'list'; items: string[] }
  | { kind: 'paragraph'; text: string };

/** A table separator row: `| --- | --- |`. Not content, so it is dropped. */
function isDivider(line: string): boolean {
  return /^\|[\s|:-]+\|$/.test(line);
}

function cells(line: string): string[] {
  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

export function parseReport(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      index += 1;
      continue;
    }

    if (line.startsWith('|')) {
      const header = cells(line);
      index += 1;
      if (index < lines.length && isDivider(lines[index] ?? '')) index += 1;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('|')) {
        rows.push(cells(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('- ')) {
        items.push((lines[index] ?? '').slice(2).trim());
        index += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    // Paragraphs are hard-wrapped in the source; rejoin them so the page
    // reflows rather than breaking at the report's 80-column margins.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '' || current.startsWith('|') || current.startsWith('- ')) break;
      if (/^#{1,6}\s/.test(current)) break;
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

/**
 * `**bold**` and `` `code` ``, and nothing else.
 *
 * The report uses emphasis to mark the sentences that must not be skimmed past
 * -- "the disputed amount is deliberately not part of the false-positive cost",
 * "assumption" -- so dropping it would flatten exactly the wrong words.
 */
function inline(text: string, keyPrefix: string): (string | JSX.Element)[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      // Recurse, because bold wrapping code is a real shape in the report and
      // the flat version rendered it wrong: `**\`qwen/qwen3.8-27b\`**` came out
      // as bold text with literal backticks in it, on the page a judge reads
      // most carefully. The split pattern only matches `**` around non-asterisk
      // runs, so the inner text can never contain another `**` and this
      // terminates after one level.
      return (
        <strong key={`${keyPrefix}-${i}`}>{inline(part.slice(2, -2), `${keyPrefix}-${i}b`)}</strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={`${keyPrefix}-${i}`}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

export function ReportView({ markdown }: { markdown: string }) {
  return (
    <div className="report">
      {parseReport(markdown).map((block, i) => {
        const key = `b${i}`;
        if (block.kind === 'heading') {
          const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2';
          return <Tag key={key}>{inline(block.text, key)}</Tag>;
        }
        if (block.kind === 'table') {
          // The first column names the thing; every other column is a figure
          // for it. That is true of every table the report emits, and it is
          // what lets the numbers be set right-aligned in mono so a reader can
          // compare a column down the page instead of reading it across.
          // Nothing here decides what a number IS -- the cells are still the
          // report's own bytes, rendered verbatim (P4.2).
          return (
            <table key={key}>
              <thead>
                <tr>
                  {block.header.map((cell, c) => (
                    <th key={`${key}-h${c}`} className={c === 0 ? '' : 'num'}>
                      {inline(cell, `${key}-h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={`${key}-r${r}`}>
                    {row.map((cell, c) => (
                      <td key={`${key}-r${r}c${c}`} className={c === 0 ? 'rowname' : 'num'}>
                        {inline(cell, `${key}-r${r}c${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        if (block.kind === 'list') {
          return (
            <ul key={key}>
              {block.items.map((item, li) => (
                <li key={`${key}-l${li}`}>{inline(item, `${key}-l${li}`)}</li>
              ))}
            </ul>
          );
        }
        return <p key={key}>{inline(block.text, key)}</p>;
      })}
    </div>
  );
}

export function Report() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchEvalReport()
      .then(setMarkdown)
      .catch((cause: unknown) => setError((cause as Error).message));
  }, []);

  if (error) {
    return (
      <div className="report">
        <p className="error">Could not load the eval report: {error}</p>
        <p>
          The report is generated by <code>pnpm eval</code> and committed at{' '}
          <code>eval/results.md</code>. This page renders that file and computes nothing of its
          own, so an empty page here means the report is missing, never that the numbers differ.
        </p>
      </div>
    );
  }

  if (markdown === null) return <div className="report">Loading the eval report…</div>;
  return <ReportView markdown={markdown} />;
}
