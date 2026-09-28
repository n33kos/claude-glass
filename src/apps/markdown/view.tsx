import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from '../../renderer/markdown';
import type { AppViewProps } from '../../sdk/react';
import type { MarkdownState } from './index';

// Following links: a link to another markdown file opens it here (the host reads it, if it's in the
// project or next to the document), with Back and a way home to what Claude showed; #section links
// scroll; web links open in the user's browser. Navigation is the viewer's own (view-only): when
// Claude changes the content, the viewer goes home to it.
interface Page { path: string; text: string }

/** `href` against the folder of `from` (a file path): handles ./, ../, absolute paths and %xx. */
function resolvePath(from: string | undefined, href: string): string | null {
  const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
  if (clean.startsWith('/')) return normalize(clean);
  if (!from) return null;
  return normalize(`${from.slice(0, from.lastIndexOf('/'))}/${clean}`);
}
function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
}
const slug = (s: string) => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

export default function MarkdownView({ state, host, ask }: AppViewProps<MarkdownState>) {
  const [stack, setStack] = useState<Page[]>([]); // pages opened from links, newest last
  const [note, setNote] = useState('');
  const page = stack[stack.length - 1];
  const content = page ? page.text : state.content;
  const path = page ? page.path : state.source;
  const html = useMemo(() => renderMarkdown(content), [content]);
  const ref = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const prev = useRef(state.content);
  const pendingHash = useRef<string | null>(null);

  // Claude changed the content: back home to it. Newest in view: an append scrolls to the bottom,
  // a replacement starts at the top.
  useLayoutEffect(() => {
    const el = ref.current;
    const before = prev.current;
    prev.current = state.content;
    if (before === state.content) return;
    setStack([]);
    setNote('');
    if (el) el.scrollTop = before && state.content.startsWith(before) ? el.scrollHeight : 0;
  }, [state.content]);

  // Headings get ids so #section links land; then scroll to a pending #section (or the top).
  useLayoutEffect(() => {
    const seen = new Map<string, number>();
    article.current?.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
      const base = slug(h.textContent ?? '');
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      h.id = n ? `${base}-${n}` : base;
    });
    const hash = pendingHash.current;
    pendingHash.current = null;
    if (hash) scrollToHash(hash);
  }, [html]);

  const scrollToHash = (hash: string) => {
    const el = article.current?.querySelector(`#${CSS.escape(decodeURIComponent(hash))}`);
    if (el) el.scrollIntoView({ block: 'start' });
  };

  const open = async (href: string) => {
    setNote('');
    if (href.startsWith('#')) return scrollToHash(href.slice(1));
    if (/^(https?:|mailto:)/i.test(href)) return host('open-link', { url: href });
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return setNote(`Can't open ${href.split(':')[0]}: links here.`);
    const target = resolvePath(path, href);
    if (!target) return setNote('This text has no file behind it, so relative links have nothing to start from.');
    if (!/\.(md|markdown|mdx|txt)$/i.test(target)) return setNote(`Only links to markdown files open here (${target.split('/').pop()}).`);
    try {
      const doc = await ask<Page>('read-doc', { path: target });
      pendingHash.current = href.includes('#') ? href.split('#')[1] : null;
      setStack((s) => [...s, doc]);
      if (!pendingHash.current && ref.current) ref.current.scrollTop = 0;
    } catch (e) {
      setNote(`Couldn't open ${target.split('/').pop()}: ${(e as Error).message}.`);
    }
  };

  // Links in the rendered markdown: never navigate the frame itself.
  useEffect(() => {
    const el = article.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a');
      const href = a?.getAttribute('href');
      if (!a || !href) return;
      e.preventDefault();
      void open(href);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  });

  if (!state.content && !page) return <div className="md-empty">Nothing here yet.</div>;
  return (
    <div className="markdown" ref={ref}>
      {stack.length > 0 ? (
        <div className="md-nav">
          <button onClick={() => setStack((s) => s.slice(0, -1))} title="Back">‹ Back</button>
          <button onClick={() => setStack([])} title="Back to what Claude showed">Claude's page</button>
          <span className="md-source" title={path}>{path?.split('/').pop()}</span>
        </div>
      ) : path && <div className="md-source" title={path}>{path.split('/').pop()}</div>}
      {note && <div className="md-note">{note}</div>}
      <article className="md" ref={article} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
