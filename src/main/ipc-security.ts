interface Frame {
  url: string
  detached?: boolean
}
interface Sender {
  mainFrame: Frame
}
interface SenderEvent {
  sender: Sender
  senderFrame: Frame | null
}

/** Verify identity and exact document, not merely an origin or URL prefix. */
export function isTrustedWindowRequest(
  event: SenderEvent,
  expectedSender: Sender,
  trustedUrl: string
): boolean {
  if (
    event.sender !== expectedSender ||
    !event.senderFrame ||
    event.senderFrame.detached ||
    event.senderFrame !== expectedSender.mainFrame
  )
    return false
  try {
    const actual = new URL(event.senderFrame.url)
    const expected = new URL(trustedUrl)
    actual.hash = expected.hash = ''
    return actual.href === expected.href
  } catch {
    return false
  }
}
