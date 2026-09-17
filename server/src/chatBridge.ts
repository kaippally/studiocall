/**
 * The YouTube ↔ Clubhouse chat bridge's one vocabulary.
 *
 * A relayed line is `[YT][Name] text` in the room and `[CH][Name] text` on YouTube. The tag is
 * also the mark: a line wearing one is never relayed again (so two bridges facing each other
 * cannot ping-pong) and never goes on the canvas (the original already did, from its own feed).
 */
export function bridgeLine(from: 'YT' | 'CH', author: string, text: string): string {
  return `[${from}][${author || 'viewer'}] ${text}`;
}

export const isBridged = (text: string): boolean => /^\[(YT|CH)\]\[/.test(text);
