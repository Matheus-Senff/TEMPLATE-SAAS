/** Central query keys: invalidate by prefix, e.g. `queryClient.invalidateQueries({ queryKey: queryKeys.files.all })`. */
export const queryKeys = {
  notifications: { all: ["notifications"] as const, list: (userId: string) => ["notifications", userId] as const },
  files: { all: ["files"] as const, list: (userId: string) => ["files", userId] as const },
  mfa: ["mfa"] as const,
} as const;
