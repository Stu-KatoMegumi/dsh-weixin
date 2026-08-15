/** Convert common Markdown constructs into readable WeChat plain text. */
export function formatForWeChat(input) {
  return String(input || '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[$1]')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1：$2')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '▌')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '')
    .replace(/^\s*\|(.+)\|\s*$/gm, (_, row) => row.split('|').map(cell => cell.trim()).join(' ｜ '))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Find a human-friendly cut point without splitting a URL or word if possible. */
export function safeTextCut(text, maximum) {
  if (text.length <= maximum) return text.length
  const floor = Math.max(1, Math.floor(maximum * 0.55))
  const window = text.slice(0, maximum + 1)
  for (const expression of [/\n(?=[^\n]*$)/, /[。！？!?；;](?=[^。！？!?；;]*$)/, /[，,、 ](?=[^，,、 ]*$)/]) {
    const match = window.slice(floor).match(expression)
    if (match) return floor + match.index + match[0].length
  }
  return maximum
}

/** Incremental formatter that keeps incomplete Markdown markers out of early chunks. */
export class StreamFormatter {
  constructor() {
    this.raw = ''
    this.sentFormattedLength = 0
  }

  append(delta) {
    this.raw += delta
  }

  pending() {
    const formatted = formatForWeChat(this.raw)
    return formatted.slice(this.sentFormattedLength)
  }

  consume(count) {
    this.sentFormattedLength += count
  }
}
