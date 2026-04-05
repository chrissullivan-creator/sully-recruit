export const candidateStatuses = [
  "new",
  "contacted",
  "engaged",
  "back_of_resume",
  "placed",
  "inactive"
] as const

export type CandidateStatus = (typeof candidateStatuses)[number]
