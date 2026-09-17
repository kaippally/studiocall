/**
 * Break a long line into pieces a chat will accept, at word boundaries where there are any.
 *
 * YouTube truncates past ~200 characters and Clubhouse's composer is capped too, so a host's
 * long answer used to go out with its end missing. A piece never starts or ends on a space; a
 * single word longer than `max` is cut mid-word rather than dropped.
 */
export function splitMessage(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
