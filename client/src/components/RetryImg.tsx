import { useEffect, useState } from 'react';

/**
 * An <img> that tries again when the load fails.
 *
 * A roster of forty faces is forty requests on one HTTP/2 connection, and the spdy layer answers
 * some of them with "New stream after GOAWAY" — the file is on disk and serves fine one second
 * later, but the browser has already drawn its broken-image glyph and will not ask again. So this
 * asks again, a few times, with a widening gap and a cache-buster so the browser makes a real
 * request rather than replaying the failure.
 */
export function RetryImg({ src, tries = 4, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { src: string; tries?: number }) {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setAttempt(0); }, [src]);
  const url = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}r=${attempt}`;
  return (
    <img
      {...rest}
      src={url}
      onError={() => {
        if (attempt >= tries) return;
        window.setTimeout(() => setAttempt(a => (a === attempt ? a + 1 : a)), 400 * 2 ** attempt);
      }}
    />
  );
}
