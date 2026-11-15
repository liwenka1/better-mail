import type { DraftAttachment } from '../../shared/model'

export const MAX_DRAFT_ATTACHMENTS = 20

/** Reject a whole selection rather than silently dropping files the user chose. */
export function mergeDraftAttachments(
  existing: readonly DraftAttachment[],
  selected: readonly DraftAttachment[]
): DraftAttachment[] {
  const merged = new Map(existing.map((attachment) => [attachment.id, attachment]))
  const remaining = Math.max(0, MAX_DRAFT_ATTACHMENTS - merged.size)
  for (const attachment of selected) {
    if (!merged.has(attachment.id)) merged.set(attachment.id, attachment)
  }
  if (merged.size > MAX_DRAFT_ATTACHMENTS) {
    throw new Error(`每封邮件最多添加20个附件，当前还可添加${remaining}个。`)
  }
  return [...merged.values()]
}
