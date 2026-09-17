// Per-grapheme span splitting, shared by every char-level effect (typeWriter,
// letterBlurIn). Walks an fx element's text nodes, wraps each grapheme in an inline
// span (inheriting its parent span's colour/font) and tags it, so a replay without a
// React re-render reuses the spans instead of nesting spans inside spans.
// Grapheme-aware via Intl.Segmenter so complex-script clusters (Indic, emoji sequences) stay a unit.

function splitGraphemes(s: string): string[] {
  const Seg = (Intl as any).Segmenter;
  if (Seg) {
    const seg = new Seg(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(s), (x: any) => x.segment as string);
  }
  return Array.from(s);
}

// `attr` distinguishes the main reveal spans from the surface-reflection clone's
// spans; `inReflection` selects which subtree to wrap.
function getCharSpans(root: HTMLElement, attr: string, inReflection: boolean): HTMLElement[] {
  const existing = root.querySelectorAll<HTMLElement>(`span[${attr}]`);
  if (existing.length) return Array.from(existing);

  const out: HTMLElement[] = [];
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      !!n.parentElement?.closest('[data-l3-reflection]') === inReflection
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

  for (const tn of textNodes) {
    const parent = tn.parentNode;
    if (!parent) continue;
    const frag = document.createDocumentFragment();
    for (const g of splitGraphemes(tn.textContent ?? '')) {
      const span = document.createElement('span');
      span.setAttribute(attr, '');
      span.textContent = g;
      frag.appendChild(span);
      out.push(span);
    }
    parent.replaceChild(frag, tn);
  }
  return out;
}

// Main reveal spans plus the reflection clone's spans (same DOM structure → 1:1 by
// index), so the floor mirror reveals in lockstep with the main text instead of
// showing the whole line up front.
export function getMainSpans(root: HTMLElement): HTMLElement[] { return getCharSpans(root, 'data-l3char', false); }
export function getReflSpans(root: HTMLElement): HTMLElement[] { return getCharSpans(root, 'data-l3char-refl', true); }
